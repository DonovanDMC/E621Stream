import Debug from "@yiffy/debug";

import { cursorKey, redisPrefix, updateSnapshotTTLSeconds } from "../config.ts";
import { e621, getHTML, request } from "../e621.ts";
import { publish, type EventType } from "../events.ts";
import redis from "../redis.ts";

interface Item { created_at?: string | null; id: number; updated_at?: string | null }
interface SearchOptions { ids?: Array<number>; limit: number; page: number }
interface IdsOptions { limit: number; page: number; since: Date | null }
type Changes = Record<string, { new: unknown; old: unknown }>;

/** which fields of a record count as an edit, and where its snapshots live */
export interface Tracked {
    fields: Array<string>;
    /** an id list kept in the snapshot, whose additions and removals go out as their own events instead of as changes */
    members?: { added: EventType; field: string; removed: EventType };
    /** the key the record is under in the event data, e.g. { comment, changes } */
    resource: string;
}

export interface UpdateSource extends Tracked {
    /** window mode only, for lists with no create feed of their own: ids past the newest one seen are published as this */
    createEvent?: EventType;
    event: EventType;
    intervalMS: number;
    /**
     * - `ordered`: the endpoint can sort by updated_at, so it's walked newest first until reaching the last poll
     * - `window`: it can't, so the newest `pages` pages by id are rescanned and compared every poll
     */
    mode: "ordered" | "window";
    name: string;
    pages: number;
    /** emit with `changes: null` for records changed before we had a snapshot of them */
    unknownChanges: boolean;
    /** finds the ids of a page of updated records some other way, which are then fetched with `search({ ids })` */
    ids?(options: IdsOptions): Promise<Array<number>>;
    /** records only the ingester's own account can see, which shouldn't go out */
    private?(item: Item): boolean;
    search(options: SearchOptions): Promise<Array<Item> | null>;
}

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
} satisfies Record<string, Tracked>;

const LIMIT = 320;
// a little slack so records updated in the same instant as the last poll's newest aren't skipped
const OVERLAP_MS = 5000;
// a record whose updated_at is this close to created_at is the creation itself, which the create feed covers
const CREATION_SLACK_MS = 2000;
// how far back an id lookup goes when there's no cursor yet
const FIRST_RUN_MS = 10 * 60_000;

// comments.json 403s ordering or filtering by updated_at, but the html page doesn't
// https://github.com/e621ng/e621ng/issues/2298
async function updatedCommentIds({ limit, page, since }: IdsOptions): Promise<Array<number>> {
    // the range keeps the page small, a full page of comment html is several megabytes
    const from = since ?? new Date(Date.now() - FIRST_RUN_MS);
    const html = await getHTML("/comments", { "group_by": "comment", limit, page, "search[order]": "updated_at_desc", "search[updated_at]": `${from.toISOString()}..` });
    return [...new Set(Array.from(html.matchAll(/data-comment-id="(\d+)"/g), m => Number(m[1])))];
}

/** the ingester's account can see its own private sets */
export const isPrivateSet = (item: Item): boolean => !(item as { is_public?: boolean }).is_public;

const ids = (options: SearchOptions): string | undefined => options.ids?.join(",");

export const UPDATES: Array<UpdateSource> = [
    { ...TRACKED.comment, name: "comment_updates", event: "comment.update", mode: "ordered", pages: 5, intervalMS: 30_000, unknownChanges: true, ids: updatedCommentIds, search: o => e621.comments.search({ limit: o.limit, id: ids(o), group_by: "comment" }) },
    // forum posts ignore updated_at ordering, so recent ones are rescanned
    // https://github.com/e621ng/e621ng/pull/2716
    { ...TRACKED.forumPost, name: "forum_post_updates", event: "forum_post.update", mode: "window", pages: 1, intervalMS: 30_000, unknownChanges: false, search: o => e621.forumPosts.search(o) },
    // every reply bumps a topic's updated_at, so one we know nothing about isn't worth reporting
    { ...TRACKED.forumTopic, name: "forum_topic_updates", event: "forum_topic.update", mode: "ordered", pages: 5, intervalMS: 30_000, unknownChanges: false, search: o => e621.forumTopics.search({ ...o, order: "updated_at_desc" }) },
    { ...TRACKED.tagAlias, name: "tag_alias_updates", event: "tag_alias.update", mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: true, search: o => e621.tagAliases.search({ ...o, order: "updated_at" }) },
    { ...TRACKED.tagImplication, name: "tag_implication_updates", event: "tag_implication.update", mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: true, search: o => e621.tagImplications.search({ ...o, order: "updated_at" }) },
    { ...TRACKED.bulkUpdateRequest, name: "bulk_update_request_updates", event: "bulk_update_request.update", mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: true, search: o => e621.bulkUpdateRequests.search({ ...o, order: "updated_at_desc" }) },
    // adding or removing posts bumps a set's updated_at too, those go out as post_set.add_posts/remove_posts
    { ...TRACKED.postSet, name: "post_set_updates", event: "post_set.update", mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: false, private: isPrivateSet, search: o => e621.postSets.search({ ...o, order: "updated_at" }) },
    // these can't be ordered by updated_at either
    { ...TRACKED.postFlag, name: "post_flag_updates", event: "post_flag.update", mode: "window", pages: 1, intervalMS: 60_000, unknownChanges: false, search: o => e621.postFlags.search(o) },
    { ...TRACKED.takedown, name: "takedown_updates", event: "takedown.update", mode: "window", pages: 1, intervalMS: 60_000, unknownChanges: false, search: o => e621.takedowns.search(o) },
    { ...TRACKED.newsUpdate, name: "news_update_updates", event: "news_update.update", mode: "window", pages: 1, intervalMS: 120_000, unknownChanges: false, search: o => e621.newsUpdates.search(o) },
    // the help list is short and unpaginated, so all of it is rescanned
    { ...TRACKED.helpPage, name: "help_pages", event: "help_page.update", createEvent: "help_page.create", mode: "window", pages: 1, intervalMS: 120_000, unknownChanges: false, search: () => e621.helpPages.list() },
];

const snapshotKey = (tracked: Tracked, id: number): string => `${redisPrefix}:${tracked.resource}:${id}`;

function pick(tracked: Tracked, item: Item): Record<string, unknown> {
    const record = item as unknown as Record<string, unknown>;
    const fields = tracked.members ? [...tracked.fields, tracked.members.field] : tracked.fields;
    return Object.fromEntries(fields.map(field => [field, record[field] ?? null]));
}

/** what was added to and removed from an id list */
export function membership(before: unknown, after: unknown): { added: Array<number>; removed: Array<number> } {
    const a = new Set(Array.isArray(before) ? before as Array<number> : []), b = new Set(Array.isArray(after) ? after as Array<number> : []);
    return { added: [...b].filter(id => !a.has(id)), removed: [...a].filter(id => !b.has(id)) };
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>, skip?: string): Changes {
    const changes: Changes = {};
    for (const [field, value] of Object.entries(after)) {
        if (field === skip) continue;
        if (JSON.stringify(before[field] ?? null) !== JSON.stringify(value)) changes[field] = { old: before[field] ?? null, new: value };
    }
    return changes;
}

/** stores the current state of new records, so their first edit can be diffed */
export async function remember(tracked: Tracked, items: Array<Item>): Promise<void> {
    for (const item of items) await redis.set(snapshotKey(tracked, item.id), JSON.stringify(pick(tracked, item)), "EX", updateSnapshotTTLSeconds);
}

export class UpdateFeed {
    // ms timestamp of the newest updated_at handled, ordered mode only
    private cursor: number | null = null;
    // newest id seen, window mode with createEvent only
    private maxId: number | null = null;
    constructor(readonly source: UpdateSource) {}

    /** `full` is whether there could be another page */
    private async fetch(page: number, since: Date | null = null): Promise<{ full: boolean; items: Array<Item> }> {
        const { source } = this;
        if (!source.ids) {
            const items = await request(source.name, () => source.search({ limit: LIMIT, page })) ?? [];
            return { items, full: items.length === LIMIT };
        }
        const ids = await request(`${source.name} ids`, () => source.ids!({ limit: LIMIT, page, since }));
        if (ids.length === 0) return { items: [], full: false };
        const items = await request(source.name, () => source.search({ limit: LIMIT, page: 1, ids })) ?? [];
        // back in the order the ids came in
        const order = new Map(ids.map((id, i) => [id, i]));
        items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        return { items, full: ids.length === LIMIT };
    }

    private async handle(all: Array<Item>, emitUnknown: boolean): Promise<number> {
        const items = this.source.private ? all.filter(item => !this.source.private!(item)) : all;
        if (items.length === 0) return 0;
        const previous = await redis.mget(...items.map(item => snapshotKey(this.source, item.id)));
        let published = 0;
        const { members, resource } = this.source;
        for (const [i, item] of items.entries()) {
            const after = pick(this.source, item);
            const stored = previous[i];
            const before = stored ? JSON.parse(stored) as Record<string, unknown> : null;
            const changes = before ? diff(before, after, members?.field) : null;
            // snapshots from before the list was tracked don't have it, so nothing is known about what moved
            const moved = before && members && members.field in before ? membership(before[members.field], after[members.field]) : null;
            const movedAny = moved !== null && (moved.added.length !== 0 || moved.removed.length !== 0);
            // window mode sees the same records every poll, only write when something's new
            if (!changes || Object.keys(changes).length !== 0 || movedAny) await redis.set(snapshotKey(this.source, item.id), JSON.stringify(after), "EX", updateSnapshotTTLSeconds);
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
        return published;
    }

    private async pollOrdered(): Promise<number> {
        const field = `${this.source.name}:updated_at`;
        if (this.cursor === null) {
            const stored = await redis.hget(cursorKey, field);
            if (stored) {
                this.cursor = Number(stored);
            } else {
                // first run starts now, and remembers what the newest records look like so their next edit has a diff
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

        // oldest first, so events go out in the order they happened
        found.reverse();
        const published = await this.handle(found, this.source.unknownChanges);
        const newest = Math.max(this.cursor, ...found.map(item => Date.parse(item.updated_at ?? "")).filter(t => !Number.isNaN(t)));
        if (newest > this.cursor) {
            this.cursor = newest;
            await redis.hset(cursorKey, field, String(newest));
        }
        return published;
    }

    private async pollWindow(): Promise<number> {
        const items: Array<Item> = [];
        for (let page = 1; page <= this.source.pages; page++) {
            const { full, items: batch } = await this.fetch(page);
            items.push(...batch);
            if (!full) break;
        }
        items.sort((a, b) => a.id - b.id);
        const created = await this.publishCreates(items);
        // records without a snapshot are only stored, which also keeps the very first pass quiet
        return created.count + await this.handle(items.filter(item => !created.ids.has(item.id)), false);
    }

    private async publishCreates(items: Array<Item>): Promise<{ count: number; ids: Set<number> }> {
        const ids = new Set<number>();
        const { createEvent } = this.source;
        if (!createEvent || items.length === 0) return { count: 0, ids };
        const field = `${this.source.name}:max_id`;
        const newest = items.at(-1)!.id;
        if (this.maxId === null) {
            const stored = await redis.hget(cursorKey, field);
            if (!stored) {
                // first run, everything already there isn't new
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

    poll(): Promise<number> {
        return this.source.mode === "ordered" ? this.pollOrdered() : this.pollWindow();
    }
}
