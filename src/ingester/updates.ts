import Debug from "@yiffy/debug";

import { cursorKey } from "../config.ts";
import { deleteSnapshots, getSnapshots, putSnapshots, versionOf, type Snapshot } from "../db.ts";
import { e621, getHTML, request } from "../e621.ts";
import { publish, type EventType } from "../events.ts";
import redis from "../redis.ts";

// update feeds, for records that change after they're created (comments get edited, aliases get approved, ...). e621
// doesn't say what changed, so the fields we care about are snapshotted and every update is diffed against that.
// <resource>.update carries the record and `changes`, { field: { old, new } }
// the snapshots come from the id feeds (new records), the backfill (old records), and these feeds themselves

export interface Item { created_at?: string | null; id: number; updated_at?: string | null }
interface SearchOptions { ids?: Array<number>; limit: number; page: number }
interface IdsOptions { limit: number; page: number; since: Date | null }
type Changes = Record<string, { new: unknown; old: unknown }>;

// a resource that gets snapshotted, and which of its fields
export interface Tracked {
    fields: Array<string>;
    // a list of post ids that gets its own add/remove events instead of being in `changes`
    members?: { added: EventType; field: string; removed: EventType };
    // the snapshots table's `resource`, also the key the record is under in event data
    resource: string;
}

export interface UpdateSource extends Tracked {
    // for sources without an id feed of their own (help pages), new ids are published as this
    createEvent?: EventType;
    event: EventType;
    intervalMS: number;
    /** window: can't be sorted by updated_at, so the newest pages get rescanned every poll */
    mode: "ordered" | "window";
    name: string;
    // the most pages one poll goes through
    pages: number;
    // whether to publish an update with `changes: null` for records we have no snapshot of. only for sources where
    // updated_at really means it was edited (forum topics bump it on every reply, so they don't)
    unknownChanges: boolean;
    // gets the ids in updated order when search can't be sorted that way, search then fetches them by id
    ids?(options: IdsOptions): Promise<Array<number>>;
    private?(item: Item): boolean;
    search(options: SearchOptions): Promise<Array<Item> | null>;
}

// what's snapshotted for each resource. the id feeds, update feeds, backfill crawls & exports all use these so their
// snapshots line up
export const TRACKED = {
    comment: { resource: "comment", fields: ["body", "is_hidden", "is_sticky", "warning_type", "warning_user_id"] },
    forumPost: { resource: "forum_post", fields: ["body", "is_hidden", "warning_type", "warning_user_id"] },
    forumTopic: { resource: "forum_topic", fields: ["title", "category_id", "is_hidden", "is_locked", "is_sticky"] },
    tagAlias: { resource: "tag_alias", fields: ["status", "antecedent_name", "consequent_name", "reason", "approver_id", "forum_topic_id"] },
    tagImplication: { resource: "tag_implication", fields: ["status", "antecedent_name", "consequent_name", "reason", "approver_id", "forum_topic_id"] },
    bulkUpdateRequest: { resource: "bulk_update_request", fields: ["status", "title", "script", "approver_id", "forum_topic_id"] },
    helpPage: { resource: "help_page", fields: ["name", "title", "wiki_page", "related"] },
    takedown: { resource: "takedown", fields: ["status"] },
    postFlag: { resource: "post_flag", fields: ["is_resolved"] },
    postSet: { resource: "post_set", fields: ["name", "shortname", "description", "is_public", "transfer_on_delete"], members: { field: "post_ids", added: "post_set.add_posts", removed: "post_set.remove_posts" } },
    newsUpdate: { resource: "news_update", fields: ["message"] },
    postReplacement: { resource: "post_replacement", fields: ["status", "approver_id", "reason", "post_id"] },
} satisfies Record<string, Tracked>;

const LIMIT = 320;
// e621 won't go past this page of numbered results
const MAX_PAGE = 750;
// ordered polls go back this far past the cursor, in case updated_at commits a little out of order
const OVERLAP_MS = 5000;
// updated_at within this of created_at is the record being created, not an edit
const CREATION_SLACK_MS = 2000;
// how far back comment ids are looked for when there's no cursor yet
const FIRST_RUN_MS = 10 * 60_000;

// comments.json 403s when ordering by updated_at, the html page doesn't
// https://github.com/e621ng/e621ng/issues/2298
async function updatedCommentIds({ limit, page, since }: IdsOptions): Promise<Array<number>> {
    // a full page of comment html is several megabytes
    const from = since ?? new Date(Date.now() - FIRST_RUN_MS);
    const html = await getHTML("/comments", { "group_by": "comment", limit, page, "search[order]": "updated_at_desc", "search[updated_at]": `${from.toISOString()}..` });
    return [...new Set(Array.from(html.matchAll(/data-comment-id="(\d+)"/g), m => Number(m[1])))];
}

// private sets are only ever sent to their owner, see gateway/private.ts
export const isPrivateSet = (item: Item): boolean => !(item as { is_public?: boolean }).is_public;

// search[id] takes a comma separated list
const ids = (options: SearchOptions): string | undefined => options.ids?.join(",");

// ordered ones have to come back newest update first. which `order` gets that differs between endpoints
export const UPDATES: Array<UpdateSource> = [
    { ...TRACKED.comment, name: "comment_updates", event: "comment.update", mode: "ordered", pages: 5, intervalMS: 30_000, unknownChanges: true, ids: updatedCommentIds, search: o => e621.comments.search({ limit: o.limit, id: ids(o), group_by: "comment" }) },
    // forum posts ignore updated_at ordering, so recent ones are rescanned
    // https://github.com/e621ng/e621ng/pull/2716
    { ...TRACKED.forumPost, name: "forum_post_updates", event: "forum_post.update", mode: "window", pages: 1, intervalMS: 30_000, unknownChanges: false, search: o => e621.forumPosts.search(o) },
    // every reply bumps updated_at
    { ...TRACKED.forumTopic, name: "forum_topic_updates", event: "forum_topic.update", mode: "ordered", pages: 5, intervalMS: 30_000, unknownChanges: false, search: o => e621.forumTopics.search({ ...o, order: "updated_at_desc" }) },
    { ...TRACKED.tagAlias, name: "tag_alias_updates", event: "tag_alias.update", mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: true, search: o => e621.tagAliases.search({ ...o, order: "updated_at" }) },
    { ...TRACKED.tagImplication, name: "tag_implication_updates", event: "tag_implication.update", mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: true, search: o => e621.tagImplications.search({ ...o, order: "updated_at" }) },
    { ...TRACKED.bulkUpdateRequest, name: "bulk_update_request_updates", event: "bulk_update_request.update", mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: true, search: o => e621.bulkUpdateRequests.search({ ...o, order: "updated_at_desc" }) },
    { ...TRACKED.postSet, name: "post_set_updates", event: "post_set.update", mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: false, private: isPrivateSet, search: o => e621.postSets.search({ ...o, order: "updated_at" }) },
    { ...TRACKED.postFlag, name: "post_flag_updates", event: "post_flag.update", mode: "window", pages: 1, intervalMS: 60_000, unknownChanges: false, search: o => e621.postFlags.search(o) },
    { ...TRACKED.takedown, name: "takedown_updates", event: "takedown.update", mode: "window", pages: 1, intervalMS: 60_000, unknownChanges: false, search: o => e621.takedowns.search(o) },
    { ...TRACKED.postReplacement, name: "post_replacement_updates", event: "post_replacement.update", mode: "window", pages: 1, intervalMS: 60_000, unknownChanges: false, search: o => e621.postReplacements.search(o) },
    { ...TRACKED.newsUpdate, name: "news_update_updates", event: "news_update.update", mode: "window", pages: 1, intervalMS: 120_000, unknownChanges: false, search: o => e621.newsUpdates.search(o) },
    { ...TRACKED.helpPage, name: "help_pages", event: "help_page.update", createEvent: "help_page.create", mode: "window", pages: 1, intervalMS: 120_000, unknownChanges: false, search: () => e621.helpPages.list() },
];

// the snapshot of an item, missing fields are stored as null
export function pick(tracked: Tracked, item: Item): Record<string, unknown> {
    const record = item as unknown as Record<string, unknown>;
    const fields = tracked.members ? [...tracked.fields, tracked.members.field] : tracked.fields;
    return Object.fromEntries(fields.map(field => [field, record[field] ?? null]));
}

export function membership(before: unknown, after: unknown): { added: Array<number>; removed: Array<number> } {
    const a = new Set(Array.isArray(before) ? before as Array<number> : []), b = new Set(Array.isArray(after) ? after as Array<number> : []);
    return { added: [...b].filter(id => !a.has(id)), removed: [...a].filter(id => !b.has(id)) };
}

// skip is the members field, that's handled by membership(). fields the snapshot doesn't have (added to TRACKED later)
// aren't reported as changes
export function diff(before: Record<string, unknown>, after: Record<string, unknown>, skip?: string): Changes {
    const changes: Changes = {};
    for (const [field, value] of Object.entries(after)) {
        if (field === skip || !(field in before)) continue;
        if (JSON.stringify(before[field]) !== JSON.stringify(value)) changes[field] = { old: before[field], new: value };
    }
    return changes;
}

// stores snapshots without diffing or publishing anything
export async function remember(tracked: Tracked, items: Array<Item>): Promise<void> {
    await putSnapshots(tracked.resource, items.map(item => ({ id: item.id, version: versionOf(item), data: pick(tracked, item) })));
}

export class UpdateFeed {
    // ordered: the newest updated_at seen, in ms
    private cursor: number | null = null;
    // window with a createEvent: the highest id seen
    private maxId: number | null = null;
    constructor(readonly source: UpdateSource) {}

    // full is whether there might be another page
    private async fetch(page: number, since: Date | null = null): Promise<{ full: boolean; items: Array<Item> }> {
        const { source } = this;
        if (!source.ids) {
            const items = await request(source.name, () => source.search({ limit: LIMIT, page })) ?? [];
            return { items, full: items.length === LIMIT };
        }
        const ids = await request(`${source.name} ids`, () => source.ids!({ limit: LIMIT, page, since }));
        if (ids.length === 0) return { items: [], full: false };
        const items = await request(source.name, () => source.search({ limit: LIMIT, page: 1, ids })) ?? [];
        // back into the order the ids came in, newest update first
        const order = new Map(ids.map((id, i) => [id, i]));
        items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        return { items, full: ids.length === LIMIT };
    }

    // newest updates first, page until one's at or before the cursor, then handle them oldest first
    private async pollOrdered(): Promise<number> {
        const field = `${this.source.name}:updated_at`;
        if (this.cursor === null) {
            const stored = await redis.hget(cursorKey, field);
            if (stored) {
                this.cursor = Number(stored);
            } else {
                // first run, snapshot the newest page and start from there without publishing anything
                const { items } = await this.fetch(1);
                await remember(this.source, items);
                const times = items.map(item => Date.parse(item.updated_at ?? "")).filter(t => !Number.isNaN(t));
                this.cursor = times.length === 0 ? Date.now() : Math.max(...times);
                await redis.hset(cursorKey, field, String(this.cursor));
                Debug(`ingester:${this.source.name}`, `starting at ${new Date(this.cursor).toISOString()}`);
                return 0;
            }
        }

        const since = this.cursor - OVERLAP_MS;
        const found: Array<Item> = [];
        let caughtUp = false;
        for (let page = 1; page <= this.source.pages && !caughtUp; page++) {
            const { full, items } = await this.fetch(page, new Date(since));
            for (const item of items) {
                if (Date.parse(item.updated_at ?? "") <= since) {
                    caughtUp = true;
                    break;
                }
                found.push(item);
            }
            if (!full) caughtUp = true;
        }
        if (!caughtUp) Debug(`ingester:${this.source.name}`, `more than ${this.source.pages * LIMIT} updates since the last poll, some were skipped`);

        found.reverse();
        const published = await this.handle(found, this.source.unknownChanges);
        const newest = Math.max(this.cursor, ...found.map(item => Date.parse(item.updated_at ?? "")).filter(t => !Number.isNaN(t)));
        if (newest > this.cursor) {
            this.cursor = newest;
            await redis.hset(cursorKey, field, String(newest));
        }
        return published;
    }

    // the newest pages by id, every time. anything changed since its snapshot is an update. it only sees edits to recent
    // records, older ones get picked up some other way if at all (replacements through post events)
    private async pollWindow(): Promise<number> {
        const items: Array<Item> = [];
        for (let page = 1; page <= this.source.pages; page++) {
            const { full, items: batch } = await this.fetch(page);
            items.push(...batch);
            if (!full) break;
        }
        items.sort((a, b) => a.id - b.id);
        const created = await this.publishCreates(items);
        return created.count + await this.handle(items.filter(item => !created.ids.has(item.id)), false);
    }

    // ids above maxId are new, published as createEvent. on the first run it just records the max. ids is what was
    // published, so they aren't also diffed
    private async publishCreates(items: Array<Item>): Promise<{ count: number; ids: Set<number> }> {
        const ids = new Set<number>();
        const { createEvent } = this.source;
        if (!createEvent || items.length === 0) return { count: 0, ids };
        const field = `${this.source.name}:max_id`;
        const newest = items.at(-1)!.id;
        if (this.maxId === null) {
            const stored = await redis.hget(cursorKey, field);
            if (!stored) {
                this.maxId = newest;
                await redis.hset(cursorKey, field, String(newest));
                return { count: 0, ids };
            }
            this.maxId = Number(stored);
        }
        for (const item of items) {
            if (item.id <= this.maxId) continue;
            await publish(createEvent, item.created_at ?? new Date().toISOString(), item);
            ids.add(item.id);
        }
        await remember(this.source, items.filter(item => ids.has(item.id)));
        if (newest > this.maxId) {
            this.maxId = newest;
            await redis.hset(cursorKey, field, String(newest));
        }
        return { count: ids.size, ids };
    }

    // diffs items (oldest first) against their snapshots and publishes:
    //  - members.added / members.removed if the member list changed
    //  - event with `changes` if any tracked field changed
    //  - event with `changes: null` if there's no snapshot, emitUnknown is on, and it wasn't just created
    // snapshots are written for new records and anything that changed. private items are dropped & their snapshots deleted
    async handle(all: Array<Item>, emitUnknown: boolean): Promise<number> {
        const { members, resource } = this.source;
        const hidden = this.source.private ? all.filter(item => this.source.private!(item)) : [];
        // so a set that went private can't be looked up anymore
        await deleteSnapshots(resource, hidden.map(item => item.id));
        const items = hidden.length === 0 ? all : all.filter(item => !hidden.includes(item));
        if (items.length === 0) return 0;
        const previous = await getSnapshots(resource, items.map(item => item.id));
        const writes: Array<Snapshot> = [];
        let published = 0;
        for (const item of items) {
            const after = pick(this.source, item);
            const before = previous.get(item.id) ?? null;
            const changes = before ? diff(before, after, members?.field) : null;
            // null if there's nothing to compare the members with
            const moved = before && members && members.field in before ? membership(before[members.field], after[members.field]) : null;
            const movedAny = moved !== null && (moved.added.length !== 0 || moved.removed.length !== 0);
            if (!changes || Object.keys(changes).length !== 0 || movedAny) writes.push({ id: item.id, version: versionOf(item), data: after });
            const time = item.updated_at ?? new Date().toISOString();
            if (members && moved) {
                if (moved.added.length !== 0) await publish(members.added, time, { [resource]: item, post_ids: moved.added });
                if (moved.removed.length !== 0) await publish(members.removed, time, { [resource]: item, post_ids: moved.removed });
                published += Number(moved.added.length !== 0) + Number(moved.removed.length !== 0);
            }
            if (changes) {
                if (Object.keys(changes).length === 0) continue;
                await publish(this.source.event, time, { [resource]: item, changes });
                published++;
            } else if (emitUnknown) {
                const created = Date.parse(item.created_at ?? ""), updated = Date.parse(time);
                if (Number.isNaN(created) || updated - created <= CREATION_SLACK_MS) continue;
                await publish(this.source.event, time, { [resource]: item, changes: null });
                published++;
            }
        }
        await putSnapshots(resource, writes);
        return published;
    }

    poll(): Promise<number> {
        return this.source.mode === "ordered" ? this.pollOrdered() : this.pollWindow();
    }

    // everything updated between from and to, compared against snapshots so what was already sent is skipped. only
    // works for ordered sources, the rest can only see their newest page
    async recover(from: number, to: number, stop: () => Promise<void>): Promise<number> {
        if (this.source.mode !== "ordered") throw new Error(`${this.source.name} can't be recovered`);
        const found: Array<Item> = [];
        for (let page = 1; page <= MAX_PAGE; page++) {
            await stop();
            const { full, items } = await this.fetch(page, new Date(from));
            let done = !full;
            for (const item of items) {
                const at = Date.parse(item.updated_at ?? "");
                if (at <= from) {
                    done = true;
                    break;
                }
                if (at <= to) found.push(item);
            }
            if (done) break;
            if (page === MAX_PAGE) Debug(`ingester:${this.source.name}`, `recovery: more than ${MAX_PAGE} pages of updates, the oldest were skipped`);
        }
        found.reverse();
        return this.handle(found, this.source.unknownChanges);
    }
}
