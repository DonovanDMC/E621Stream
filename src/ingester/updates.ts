import Debug from "@yiffy/debug";

import Config from "../Config.ts";
import Redis from "../db/Redis.ts";
import { publish, type EventContext, type EventType, type EventTypeDataMap } from "../gateway/events.ts";
import { getSnapshotIDs, getSnapshots, modActionUpdater, removeSnapshots, saveSnapshots, versionOf, type SnapshotResourceType } from "../gateway/snapshots.ts";
import { e621, request } from "../util/e621.ts";

import type { PollResult } from "./feedLog.ts";
import type { Item } from "./feeds.ts";

const cursorKey = `${Config.redisPrefix}cursors`;
const LIMIT = 320;
const MAX_PAGE = 750;
// updated_at ordering isn't exact, so every poll goes a little further back
const OVERLAP_MS = 5000;
// an update this soon after being made is still the create
const CREATION_SLACK_MS = 2000;

type UpdateEvent = "bulk_update_request.update" | "comment.update" | "forum_post.update" | "forum_topic.update" | "help_page.update" | "news_update.update"
    | "post_flag.update" | "post_replacement.update" | "post_set.update" | "tag_alias.update" | "tag_implication.update" | "takedown.update" | "upload_url_rule.update"
    | "upload_whitelist.update";
type UpdateRecord = EventTypeDataMap[UpdateEvent] & Item;

export interface UpdateSource {
    createEvent?: EventType;
    /** For lists that are fetched whole, ones we have that aren't in it anymore were destroyed */
    destroyEvent?: "upload_url_rule.destroy" | "upload_whitelist.destroy";
    event: UpdateEvent;
    /** Only changes to these are sent, like a forum topic's bump isn't */
    fields: Array<string>;
    intervalMS: number;
    /** Members added and removed are their own events */
    members?: { added: EventType; field: string; removed: EventType };
    /** ordered: sorted by updated_at, followed with a cursor. window: can't be sorted, the newest are rescanned */
    mode: "ordered" | "window";
    name: string;
    pages: number;
    resource: SnapshotResourceType;
    /** Whether ones we haven't stored are sent, when they look like they've changed since being made */
    unknownChanges: boolean;
    /** What the record doesn't say about a change, before is what we had (if we had it) */
    context?(before: UpdateRecord | undefined, after: UpdateRecord): Promise<EventContext>;
    destroyContext?(before: UpdateRecord): Promise<EventContext>;
    private?(item: UpdateRecord): boolean;
    search(options: { limit: number; page: number }): Promise<Array<UpdateRecord>>;
}

const isPrivateSet = (item: UpdateRecord): boolean => !(item as EventTypeDataMap["post_set.update"]).is_public;

// the mod action logged for a change is who made it, the approver is the next best thing for requests
function requestContext(actions: Array<string>, field: string) {
    return async (before: UpdateRecord | undefined, after: UpdateRecord): Promise<EventContext> => {
        const request = after as EventTypeDataMap["tag_alias.update"];
        const updater = await modActionUpdater(actions, field, after.id, timeOf(after));
        if (updater !== null) return { updater_id: updater };
        const decided = (before as EventTypeDataMap["tag_alias.update"] | undefined)?.status !== request.status && request.approver_id !== null;
        return decided ? { updater_id: request.approver_id! } : {};
    };
}

// owners can edit their own sets, and only staff edits are logged
async function setContext(_before: UpdateRecord | undefined, after: UpdateRecord): Promise<EventContext> {
    const updater = await modActionUpdater(["set_update", "set_change_visibility"], "set_id", after.id, timeOf(after));
    return { updater_id: updater ?? (after as EventTypeDataMap["post_set.update"]).creator_id };
}

async function helpPageContext(before: UpdateRecord | undefined, after: UpdateRecord): Promise<EventContext> {
    const updater = await modActionUpdater([before ? "help_update" : "help_create"], "name", (after as EventTypeDataMap["help_page.update"]).name, timeOf(after));
    return updater === null ? {} : { updater_id: updater };
}

// rules say who last changed them, the mod actions are only needed for deletes
async function urlRuleContext(before: UpdateRecord | undefined, after: UpdateRecord): Promise<EventContext> {
    return before ? { updater_id: (after as EventTypeDataMap["upload_url_rule.update"]).updater_id } : {};
}

async function urlRuleDestroyContext(before: UpdateRecord): Promise<EventContext> {
    const updater = await modActionUpdater(["upload_url_rule_delete"], "label", (before as EventTypeDataMap["upload_url_rule.update"]).label, new Date().toISOString());
    return updater === null ? {} : { updater_id: updater };
}

// whitelist entries don't say who made them. the mod actions only show non-admins the note, so that's what they're matched by
async function whitelistContext(before: UpdateRecord | undefined, after: UpdateRecord): Promise<EventContext> {
    const updater = await modActionUpdater([before ? "upload_whitelist_update" : "upload_whitelist_create"], "note", (after as EventTypeDataMap["upload_whitelist.update"]).note, timeOf(after));
    return updater === null ? {} : { updater_id: updater };
}

async function whitelistDestroyContext(before: UpdateRecord): Promise<EventContext> {
    const updater = await modActionUpdater(["upload_whitelist_delete"], "note", (before as EventTypeDataMap["upload_whitelist.update"]).note, new Date().toISOString());
    return updater === null ? {} : { updater_id: updater };
}

// bulk update requests have no mod actions, whoever approved or rejected one is the only change that's known
async function bulkUpdateRequestContext(before: UpdateRecord | undefined, after: UpdateRecord): Promise<EventContext> {
    const request = after as EventTypeDataMap["bulk_update_request.update"];
    const decided = (before as EventTypeDataMap["bulk_update_request.update"] | undefined)?.status !== request.status && request.approver_id !== null;
    return decided ? { updater_id: request.approver_id! } : {};
}
const requestFields = ["status", "antecedent_name", "consequent_name", "reason", "approver_id", "forum_topic_id"];

export const UPDATES: Array<UpdateSource> = [
    { name: "comment_updates", resource: "comment", event: "comment.update", fields: ["body", "is_hidden", "is_sticky", "warning_type", "warning_user_id"], mode: "ordered", pages: 5, intervalMS: 30_000, unknownChanges: true, search: o => e621.comments.search({ ...o, group_by: "comment", order: "updated_at_desc" }) },
    // forum posts ignore updated_at ordering, so recent ones are rescanned
    // https://github.com/e621ng/e621ng/pull/2716
    { name: "forum_post_updates", resource: "forum_post", event: "forum_post.update", fields: ["body", "is_hidden", "warning_type", "warning_user_id"], mode: "window", pages: 1, intervalMS: 30_000, unknownChanges: false, search: o => e621.forumPosts.search(o) },
    { name: "forum_topic_updates", resource: "forum_topic", event: "forum_topic.update", fields: ["title", "category_id", "is_hidden", "is_locked", "is_sticky"], mode: "ordered", pages: 5, intervalMS: 30_000, unknownChanges: false, search: o => e621.forumTopics.search({ ...o, order: "updated_at_desc" }) },
    { name: "tag_alias_updates", resource: "tag_alias", event: "tag_alias.update", fields: requestFields, context: requestContext(["tag_alias_create", "tag_alias_update", "tag_alias_undo"], "alias_id"), mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: true, search: o => e621.tagAliases.search({ ...o, order: "updated_at" }) },
    { name: "tag_implication_updates", resource: "tag_implication", event: "tag_implication.update", fields: requestFields, context: requestContext(["tag_implication_create", "tag_implication_update", "tag_implication_undo"], "implication_id"), mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: true, search: o => e621.tagImplications.search({ ...o, order: "updated_at" }) },
    { name: "bulk_update_request_updates", resource: "bulk_update_request", event: "bulk_update_request.update", context: bulkUpdateRequestContext, fields: ["status", "title", "script", "approver_id", "forum_topic_id"], mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: true, search: o => e621.bulkUpdateRequests.search({ ...o, order: "updated_at_desc" }) },
    { name: "post_set_updates", resource: "post_set", event: "post_set.update", context: setContext, fields: ["name", "shortname", "description", "is_public", "transfer_on_delete"], members: { field: "post_ids", added: "post_set.add_posts", removed: "post_set.remove_posts" }, mode: "ordered", pages: 5, intervalMS: 60_000, unknownChanges: false, private: isPrivateSet, search: o => e621.postSets.search({ ...o, order: "updated_at" }) },
    { name: "post_flag_updates", resource: "post_flag", event: "post_flag.update", fields: ["is_resolved"], mode: "window", pages: 1, intervalMS: 60_000, unknownChanges: false, search: o => e621.postFlags.search(o) },
    { name: "takedown_updates", resource: "takedown", event: "takedown.update", fields: ["status"], mode: "window", pages: 1, intervalMS: 60_000, unknownChanges: false, search: o => e621.takedowns.search(o) },
    { name: "post_replacement_updates", resource: "post_replacement", event: "post_replacement.update", fields: ["status", "approver_id", "reason", "post_id"], mode: "window", pages: 1, intervalMS: 60_000, unknownChanges: false, search: o => e621.postReplacements.search(o) },
    { name: "news_update_updates", resource: "news_update", event: "news_update.update", fields: ["message"], mode: "window", pages: 1, intervalMS: 120_000, unknownChanges: false, search: o => e621.newsUpdates.search(o) },
    // help pages have no search, the list is every one of them
    { name: "help_pages", resource: "help_page", event: "help_page.update", createEvent: "help_page.create", context: helpPageContext, fields: ["name", "title", "wiki_page", "related"], mode: "window", pages: 1, intervalMS: 120_000, unknownChanges: false, search: () => e621.helpPages.list() },
    // both lists are short enough to fetch whole, so deletes are found by what's missing
    { name: "upload_url_rules", resource: "upload_url_rule", event: "upload_url_rule.update", createEvent: "upload_url_rule.create", destroyEvent: "upload_url_rule.destroy", context: urlRuleContext, destroyContext: urlRuleDestroyContext, fields: ["label", "pattern", "replacement", "message", "handling", "enabled"], mode: "window", pages: 5, intervalMS: 120_000, unknownChanges: false, search: o => e621.uploadUrlRules.search(o) },
    { name: "upload_whitelists", resource: "upload_whitelist", event: "upload_whitelist.update", createEvent: "upload_whitelist.create", destroyEvent: "upload_whitelist.destroy", context: whitelistContext, destroyContext: whitelistDestroyContext, fields: ["domain", "path", "note", "hidden", "allowed", "reason"], mode: "window", pages: 5, intervalMS: 120_000, unknownChanges: false, search: o => e621.uploadWhitelists.search(o) },
];

const timeOf = (item: Item): string => item.updated_at ?? new Date().toISOString();

export function changed(fields: Array<string>, before: object, after: object): boolean {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    // backfilled snapshots can be missing fields, those aren't counted
    return fields.some(field => field in a && JSON.stringify(a[field]) !== JSON.stringify(b[field] ?? null));
}

export function membership(before: unknown, after: unknown): { added: Array<number>; removed: Array<number> } {
    const a = Array.isArray(before) ? before as Array<number> : [], b = Array.isArray(after) ? after as Array<number> : [];
    return { added: b.filter(id => !a.includes(id)), removed: a.filter(id => !b.includes(id)) };
}

/** Finds changes to records by comparing them with their snapshots */
export class UpdateFeed {
    private cursor: number | null = null;
    private maxID: number | null = null;
    readonly source: UpdateSource;
    constructor(source: UpdateSource) {
        this.source = source;
    }

    private async fetch(page: number): Promise<{ full: boolean; items: Array<UpdateRecord> }> {
        const items = await request(this.source.name, () => this.source.search({ limit: LIMIT, page }));
        return { items, full: items.length === LIMIT };
    }

    private async pollOrdered(): Promise<PollResult> {
        const field = `${this.source.name}:updated_at`;
        if (this.cursor === null) {
            const stored = await Redis.hget(cursorKey, field);
            if (stored) {
                this.cursor = Number(stored);
            } else {
                const { items } = await this.fetch(1);
                await saveSnapshots(this.source.resource, items.filter(item => !this.source.private?.(item)) as never);
                const times = items.map(item => Date.parse(timeOf(item))).filter(t => !Number.isNaN(t));
                this.cursor = times.length === 0 ? Date.now() : Math.max(...times);
                await Redis.hset(cursorKey, field, String(this.cursor));
                Debug(`ingester:${this.source.name}`, `starting at ${new Date(this.cursor).toISOString()}`);
                return { published: 0 };
            }
        }

        const since = this.cursor - OVERLAP_MS;
        const found: Array<UpdateRecord> = [];
        let caughtUp = false;
        for (let page = 1; page <= this.source.pages && !caughtUp; page++) {
            const { full, items } = await this.fetch(page);
            for (const item of items) {
                if (Date.parse(timeOf(item)) <= since) {
                    caughtUp = true;
                    break;
                }
                found.push(item);
            }
            if (!full) caughtUp = true;
        }
        const oldest = Date.parse(found.at(-1)?.updated_at ?? "");
        const skipped = caughtUp || Number.isNaN(oldest) ? undefined : { from: since, to: oldest };
        if (skipped) Debug(`ingester:${this.source.name}`, `more than ${this.source.pages * LIMIT} updates since the last poll, some were skipped`);

        found.reverse();
        const published = await this.handle(found, this.source.unknownChanges);
        const newest = Math.max(this.cursor, ...found.map(item => Date.parse(timeOf(item))).filter(t => !Number.isNaN(t)));
        if (newest > this.cursor) {
            this.cursor = newest;
            await Redis.hset(cursorKey, field, String(newest));
        }
        return { published, skipped };
    }

    private async pollWindow(): Promise<PollResult> {
        const items: Array<UpdateRecord> = [];
        let complete = false;
        for (let page = 1; page <= this.source.pages; page++) {
            const { full, items: batch } = await this.fetch(page);
            items.push(...batch);
            if (!full) {
                complete = true;
                break;
            }
        }
        items.sort((a, b) => a.id - b.id);
        const destroyed = complete ? await this.publishDestroys(items) : 0;
        const created = await this.publishCreates(items);
        return { published: destroyed + created.length + await this.handle(items.filter(item => !created.includes(item.id)), false) };
    }

    // for sources without a create feed, ones newer than the last seen id are creates
    private async publishCreates(items: Array<UpdateRecord>): Promise<Array<number>> {
        const { createEvent } = this.source;
        if (!createEvent || items.length === 0) return [];
        const field = `${this.source.name}:max_id`;
        const newest = items.at(-1)!.id;
        if (this.maxID === null) {
            const stored = await Redis.hget(cursorKey, field);
            if (!stored) {
                this.maxID = newest;
                await Redis.hset(cursorKey, field, String(newest));
                return [];
            }
            this.maxID = Number(stored);
        }
        const created = items.filter(item => item.id > this.maxID!);
        for (const item of created) await publish(createEvent, item.created_at ?? timeOf(item), item as never, await this.source.context?.(undefined, item));
        await saveSnapshots(this.source.resource, created as never);
        if (newest > this.maxID) {
            this.maxID = newest;
            await Redis.hset(cursorKey, field, String(newest));
        }
        return created.map(item => item.id);
    }

    private async publishDestroys(items: Array<UpdateRecord>): Promise<number> {
        const { destroyEvent, resource } = this.source;
        // an empty list is more likely e621 having a problem than everything being deleted
        if (!destroyEvent || items.length === 0) return 0;
        const ids = items.map(item => item.id);
        const gone = (await getSnapshotIDs(resource)).filter(id => !ids.includes(id));
        if (gone.length === 0) return 0;
        const stored = await getSnapshots(resource, gone);
        const now = new Date().toISOString();
        for (const id of gone) {
            const before = stored.get(id)?.data as UpdateRecord;
            await publish(destroyEvent, now, { id }, { ...await this.source.destroyContext?.(before), previous: before as unknown as Record<string, unknown> });
        }
        await removeSnapshots(resource, gone);
        return gone.length;
    }

    async handle(all: Array<UpdateRecord>, emitUnknown: boolean): Promise<number> {
        const { fields, members, resource } = this.source;
        // a set made private is dropped, so it's like it was never public
        const hidden = all.filter(item => this.source.private?.(item));
        await removeSnapshots(resource, hidden.map(item => item.id));
        const items = all.filter(item => !hidden.includes(item));
        if (items.length === 0) return 0;
        const stored = await getSnapshots(resource, items.map(item => item.id));
        const writes: Array<UpdateRecord> = [];
        let published = 0;
        for (const item of items) {
            const before = stored.get(item.id);
            const time = timeOf(item);
            if (before) {
                if ((versionOf(resource, item as never) ?? 0) > before.version) writes.push(item);
                const moved = members ? membership((before.data as Record<string, unknown>)[members.field], (item as unknown as Record<string, unknown>)[members.field]) : null;
                if (members && moved) {
                    if (moved.added.length !== 0) await publish(members.added, time, item as never, { post_ids: moved.added });
                    if (moved.removed.length !== 0) await publish(members.removed, time, item as never, { post_ids: moved.removed });
                    published += Number(moved.added.length !== 0) + Number(moved.removed.length !== 0);
                }
                if (changed(fields, before.data, item)) {
                    await publish(this.source.event, time, item, await this.source.context?.(before.data as UpdateRecord, item));
                    published++;
                }
                continue;
            }
            writes.push(item);
            if (!emitUnknown) continue;
            const created = Date.parse(item.created_at ?? ""), updated = Date.parse(time);
            if (Number.isNaN(created) || updated - created <= CREATION_SLACK_MS) continue;
            await publish(this.source.event, time, item, await this.source.context?.(undefined, item));
            published++;
        }
        await saveSnapshots(resource, writes as never);
        return published;
    }

    poll(): Promise<PollResult> {
        return this.source.mode === "ordered" ? this.pollOrdered() : this.pollWindow();
    }

    async recover(from: number, to: number, stop: () => Promise<void>): Promise<number> {
        if (this.source.mode !== "ordered") throw new Error(`${this.source.name} can't be recovered`);
        const found: Array<UpdateRecord> = [];
        for (let page = 1; page <= MAX_PAGE; page++) {
            await stop();
            const { full, items } = await this.fetch(page);
            let done = !full;
            for (const item of items) {
                const at = Date.parse(timeOf(item));
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
