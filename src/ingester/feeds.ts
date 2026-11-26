import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import PostVersionIndex from "../db/models/PostVersionIndex.ts";
import Redis from "../db/Redis.ts";
import { publish, type EventContext, type EventType, type EventTypeDataMap } from "../gateway/events.ts";
import { saveSnapshot, type SnapshotResourceType } from "../gateway/snapshots.ts";
import { e621, request } from "../util/e621.ts";

import { artistURLContext, artistVersionExtra, refreshArtistURLs, avoidPostingVersionContext, avoidPostingVersionExtra, modActionExtra, noteVersionExtra, poolVersionExtra, tagTypeVersionExtra, wikiPageVersionExtra, type Extra } from "./extra.ts";
import { postEventExtra } from "./postEvents.ts";

import type { PollResult } from "./feedLog.ts";

const cursorKey = `${Config.redisPrefix}cursors`;
const LIMIT = 320;
const MAX_PAGES_PER_POLL = 10;
// ids are assigned when a transaction starts, not when it commits, so rows can show up behind the cursor
// every poll starts this many ids back, and `seen` stops those being sent twice
const OVERLAP = 25;
const MAX_ID = 2_147_483_647;

export interface Page { limit: number; page: `${"a" | "b"}${number}` }
export interface Item { created_at?: string | null; id: number; updated_at?: string | null }

export interface FeedSource<T extends EventType = EventType> {
    event: T;
    intervalMS: number;
    name: string;
    /** Stored, so later versions and mod actions can be built on it */
    snapshot?: SnapshotResourceType;
    /** What the record doesn't say, for the event itself */
    context?(item: EventTypeDataMap[T]): Promise<EventContext>;
    /** More events made from this one, sent after it */
    extra?(item: EventTypeDataMap[T]): Promise<Array<Extra>>;
    /** Left out of the stream entirely */
    private?(item: EventTypeDataMap[T]): boolean;
    search(page: Page): Promise<Array<EventTypeDataMap[T]>>;
    /** Kept somewhere other than the snapshots */
    store?(item: EventTypeDataMap[T]): Promise<void>;
}

// so each source's methods get the right item type
const feed = <T extends EventType>(source: FeedSource<T>): FeedSource => source;

export const isPrivateSet = (item: { is_public: boolean }): boolean => !item.is_public;

export const FEEDS: Array<FeedSource> = [
    feed({ name: "post_versions", event: "post_version.create", intervalMS: 8000, search: page => e621.postVersions.search(page), store: async item => PostVersionIndex.remember([item]) }),
    feed({ name: "post_events", event: "post_event.create", intervalMS: 8000, search: page => e621.postEvents.search(page), extra: postEventExtra }),
    feed({ name: "comments", snapshot: "comment", event: "comment.create", intervalMS: 8000, search: page => e621.comments.search({ ...page, group_by: "comment" }) }),
    feed({ name: "forum_posts", snapshot: "forum_post", event: "forum_post.create", intervalMS: 15_000, search: page => e621.forumPosts.search(page) }),
    feed({ name: "forum_topics", snapshot: "forum_topic", event: "forum_topic.create", intervalMS: 20_000, search: page => e621.forumTopics.search(page) }),
    feed({ name: "post_flags", snapshot: "post_flag", event: "post_flag.create", intervalMS: 20_000, search: page => e621.postFlags.search(page) }),
    feed({ name: "post_replacements", snapshot: "post_replacement", event: "post_replacement.create", intervalMS: 20_000, search: page => e621.postReplacements.search(page) }),
    feed({ name: "note_versions", event: "note_version.create", intervalMS: 20_000, search: page => e621.noteVersions.search(page), extra: noteVersionExtra }),
    feed({ name: "pool_versions", event: "pool_version.create", intervalMS: 20_000, search: page => e621.poolVersions.search(page), extra: poolVersionExtra }),
    // the e621 client's mod actions don't tie each action to its values like e621-openapi's do
    feed({ name: "mod_actions", snapshot: "mod_action", event: "mod_action.create", intervalMS: 15_000, search: async page => await e621.modActions.search(page) as unknown as Array<EventTypeDataMap["mod_action.create"]>, extra: modActionExtra }),
    feed({ name: "wiki_page_versions", event: "wiki_page_version.create", intervalMS: 30_000, search: page => e621.wikiPageVersions.search(page), extra: wikiPageVersionExtra }),
    feed({ name: "artist_versions", event: "artist_version.create", intervalMS: 30_000, search: page => e621.artistVersions.search(page), extra: artistVersionExtra }),
    feed({ name: "tag_type_versions", event: "tag_type_version.create", intervalMS: 30_000, search: page => e621.tagTypeVersions.search(page), extra: tagTypeVersionExtra }),
    feed({ name: "tag_aliases", snapshot: "tag_alias", event: "tag_alias.create", intervalMS: 60_000, search: page => e621.tagAliases.search(page) }),
    feed({ name: "tag_implications", snapshot: "tag_implication", event: "tag_implication.create", intervalMS: 60_000, search: page => e621.tagImplications.search(page) }),
    feed({ name: "bulk_update_requests", snapshot: "bulk_update_request", event: "bulk_update_request.create", intervalMS: 60_000, search: page => e621.bulkUpdateRequests.search(page) }),
    feed({ name: "notes", snapshot: "note", event: "note.create", intervalMS: 30_000, search: page => e621.notes.search(page) }),
    feed({ name: "post_approvals", event: "post_approval.create", intervalMS: 20_000, search: page => e621.postApprovals.search(page) }),
    feed({ name: "upload_karma_events", event: "upload_karma_event.create", intervalMS: 20_000, search: page => e621.uploadKarmaEvents.search(page) }),
    feed({ name: "users", snapshot: "user", event: "user.create", intervalMS: 60_000, search: page => e621.users.search(page) }),
    feed({ name: "tags", snapshot: "tag", event: "tag.create", intervalMS: 60_000, search: page => e621.tags.search(page) }),
    feed({ name: "pools", snapshot: "pool", event: "pool.create", intervalMS: 60_000, search: page => e621.pools.search(page) }),
    feed({ name: "post_sets", snapshot: "post_set", event: "post_set.create", intervalMS: 60_000, search: page => e621.postSets.search(page), private: isPrivateSet }),
    feed({ name: "wiki_pages", snapshot: "wiki_page", event: "wiki_page.create", intervalMS: 60_000, search: page => e621.wikiPages.search(page) }),
    feed({ name: "artists", snapshot: "artist", event: "artist.create", intervalMS: 60_000, search: page => e621.artists.search(page) }),
    feed({ name: "artist_urls", snapshot: "artist_url", context: artistURLContext, store: refreshArtistURLs, event: "artist_url.create", intervalMS: 60_000, search: page => e621.artistUrls.search(page) }),
    feed({ name: "blips", snapshot: "blip", event: "blip.create", intervalMS: 60_000, search: page => e621.blips.search(page) }),
    feed({ name: "user_feedbacks", snapshot: "user_feedback", event: "user_feedback.create", intervalMS: 60_000, search: page => e621.userFeedbacks.search(page) }),
    feed({ name: "bans", snapshot: "ban", event: "ban.create", intervalMS: 60_000, search: page => e621.bans.search(page) }),
    feed({ name: "takedowns", snapshot: "takedown", event: "takedown.create", intervalMS: 60_000, search: page => e621.takedowns.search(page) }),
    feed({ name: "avoid_postings", snapshot: "avoid_posting", event: "avoid_posting.create", intervalMS: 120_000, search: page => e621.avoidPostings.search(page) }),
    feed({ name: "avoid_posting_versions", event: "avoid_posting_version.create", intervalMS: 120_000, search: page => e621.avoidPostingVersions.search(page), extra: avoidPostingVersionExtra, context: avoidPostingVersionContext }),
    feed({ name: "news_updates", snapshot: "news_update", event: "news_update.create", intervalMS: 120_000, search: page => e621.newsUpdates.search(page) }),
];

const timeOf = (item: Item): string => item.created_at ?? item.updated_at ?? new Date().toISOString();

/** Follows a resource by id, sending everything newer than the last id it saw */
export class Feed {
    private cursor: number | null = null;
    private floor = 0;
    private seen: Array<number> = [];
    readonly source: FeedSource;
    constructor(source: FeedSource) {
        this.source = source;
    }

    private async fetch(limit: number, page: Page["page"]): Promise<Array<Item>> {
        return await request(this.source.name, () => this.source.search({ limit, page }));
    }

    // the newest id from before the window, found by bisecting on the items' times
    private async idBefore(time: number, top: number): Promise<number> {
        let lo = 0, hi = top;
        while (hi - lo > LIMIT) {
            const mid = Math.floor((lo + hi) / 2);
            const [item] = await this.fetch(1, `b${mid + 1}`);
            if (!item) {
                lo = mid;
                continue;
            }
            const at = Date.parse(timeOf(item));
            if (at < time) lo = item.id;
            else hi = mid;
        }
        return lo;
    }

    private async init(): Promise<number> {
        const stored = await Redis.hget(cursorKey, this.source.name);
        if (stored) {
            this.cursor = this.floor = Number(stored);
            return this.cursor;
        }
        // some endpoints don't sort by id by default (forum topics sort by last bump), b<id> always does
        const [latest] = await this.fetch(1, `b${MAX_ID}`);
        this.cursor = this.floor = latest?.id ?? 0;
        await Redis.hset(cursorKey, this.source.name, String(this.cursor));
        Debug(`ingester:${this.source.name}`, `starting at id ${this.cursor}`);
        return this.cursor;
    }

    private async publishItem(item: Item): Promise<number> {
        const data = item as never;
        if (this.source.private?.(data)) return 0;
        const time = timeOf(item);
        // fetched first, so a failed lookup retries the item instead of sending it twice
        const extras = await this.source.extra?.(data) ?? [];
        await publish(this.source.event, time, data, await this.source.context?.(data));
        if (this.source.snapshot) await saveSnapshot(this.source.snapshot, data);
        await this.source.store?.(data);
        for (const extra of extras) await publish(extra.type, time, extra.data, extra.context);
        return 1 + extras.length;
    }

    private trimSeen(): void {
        if (this.cursor === null) return;
        const floor = this.cursor - OVERLAP;
        if (floor <= this.floor) return;
        this.floor = floor;
        this.seen = this.seen.filter(id => id > floor);
    }

    async poll(): Promise<PollResult> {
        let cursor = this.cursor ?? await this.init();
        let published = 0;
        for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
            const from = Math.max(page === 0 ? cursor - OVERLAP : cursor, 0);
            const items = (await this.fetch(LIMIT, `a${from}`)).sort((a, b) => a.id - b.id);
            for (const item of items) {
                if (item.id <= this.floor || this.seen.includes(item.id)) continue;
                published += await this.publishItem(item);
                this.seen.push(item.id);
            }
            const max = items.at(-1)?.id ?? cursor;
            if (max > cursor) {
                cursor = max;
                await Redis.hset(cursorKey, this.source.name, String(cursor));
            }
            if (items.length < LIMIT) break;
        }
        this.cursor = cursor;
        this.trimSeen();
        return { published };
    }

    /** Sends what was made between from and to that isn't already in the stream */
    async recover(from: number, to: number, sent: Array<number>, stop: () => Promise<void>): Promise<number> {
        const stored = await Redis.hget(cursorKey, this.source.name);
        if (!stored) return 0;
        const top = Number(stored);
        let after = await this.idBefore(from, top);
        let published = 0;
        for (;;) {
            await stop();
            const items = (await this.fetch(LIMIT, `a${after}`)).sort((a, b) => a.id - b.id);
            for (const item of items) {
                // past where polling has got to, it'll send these
                if (item.id > top) return published;
                const at = Date.parse(timeOf(item));
                if (at < from || at > to || sent.includes(item.id)) continue;
                published += await this.publishItem(item);
            }
            if (items.length < LIMIT) return published;
            after = items.at(-1)!.id;
        }
    }
}
