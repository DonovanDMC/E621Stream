import Debug from "@yiffy/debug";

import { cursorKey } from "../config.ts";
import { e621, request } from "../e621.ts";
import { MOD_ACTION_EVENTS, publish, type EventType } from "../events.ts";
import redis from "../redis.ts";

import { isPrivateSet, remember, TRACKED, type Tracked } from "./updates.ts";

interface Page { limit: number; page: `${"a" | "b"}${number}` }

export interface FeedSource {
    event: EventType;
    intervalMS: number;
    name: string;
    tracked?: Tracked;
    derive?(item: Item): EventType | undefined | Promise<EventType | undefined>;
    private?(item: Item): boolean;
    search(page: Page): Promise<Array<Item> | null>;
}

interface Item { created_at?: string | null; id: number; updated_at?: string | null }

export const FEEDS: Array<FeedSource> = [
    { name: "post_versions", event: "post_version.create", intervalMS: 8000, search: page => e621.postVersions.search(page) },
    { name: "post_events", event: "post_event.create", intervalMS: 8000, search: page => e621.postEvents.search(page) },
    { name: "comments", event: "comment.create", intervalMS: 8000, search: page => e621.comments.search({ ...page, group_by: "comment" }), tracked: TRACKED.comment },
    { name: "forum_posts", event: "forum_post.create", intervalMS: 15_000, search: page => e621.forumPosts.search(page), tracked: TRACKED.forumPost },
    { name: "forum_topics", event: "forum_topic.create", intervalMS: 20_000, search: page => e621.forumTopics.search(page), tracked: TRACKED.forumTopic },
    { name: "post_flags", event: "post_flag.create", intervalMS: 20_000, search: page => e621.postFlags.search(page), tracked: TRACKED.postFlag },
    { name: "post_replacements", event: "post_replacement.create", intervalMS: 20_000, search: page => e621.postReplacements.search(page) },
    { name: "note_versions", event: "note_version.create", intervalMS: 20_000, search: page => e621.noteVersions.search(page) },
    { name: "pool_versions", event: "pool_version.create", intervalMS: 20_000, search: page => e621.poolVersions.search(page) },
    { name: "mod_actions", event: "mod_action.create", intervalMS: 15_000, search: page => e621.modActions.search(page), derive: item => MOD_ACTION_EVENTS[(item as { action?: string }).action ?? ""] },
    { name: "wiki_page_versions", event: "wiki_page_version.create", intervalMS: 30_000, search: page => e621.wikiPageVersions.search(page) },
    { name: "artist_versions", event: "artist_version.create", intervalMS: 30_000, search: page => e621.artistVersions.search(page) },
    { name: "tag_type_versions", event: "tag_type_version.create", intervalMS: 30_000, search: page => e621.tagTypeVersions.search(page) },
    { name: "tag_aliases", event: "tag_alias.create", intervalMS: 60_000, search: page => e621.tagAliases.search(page), tracked: TRACKED.tagAlias },
    { name: "tag_implications", event: "tag_implication.create", intervalMS: 60_000, search: page => e621.tagImplications.search(page), tracked: TRACKED.tagImplication },
    { name: "bulk_update_requests", event: "bulk_update_request.create", intervalMS: 60_000, search: page => e621.bulkUpdateRequests.search(page), tracked: TRACKED.bulkUpdateRequest },
    { name: "notes", event: "note.create", intervalMS: 30_000, search: page => e621.notes.search(page) },
    { name: "post_approvals", event: "post_approval.create", intervalMS: 20_000, search: page => e621.postApprovals.search(page) },
    { name: "upload_karma_events", event: "upload_karma_event.create", intervalMS: 20_000, search: page => e621.uploadKarmaEvents.search(page) },
    { name: "users", event: "user.create", intervalMS: 60_000, search: page => e621.users.search(page) },
    { name: "tags", event: "tag.create", intervalMS: 60_000, search: page => e621.tags.search(page) },
    { name: "pools", event: "pool.create", intervalMS: 60_000, search: page => e621.pools.search(page) },
    { name: "post_sets", event: "post_set.create", intervalMS: 60_000, search: page => e621.postSets.search(page), private: isPrivateSet, tracked: TRACKED.postSet },
    { name: "wiki_pages", event: "wiki_page.create", intervalMS: 60_000, search: page => e621.wikiPages.search(page) },
    { name: "artists", event: "artist.create", intervalMS: 60_000, search: page => e621.artists.search(page) },
    { name: "artist_urls", event: "artist_url.create", intervalMS: 60_000, search: page => e621.artistUrls.search(page) },
    { name: "blips", event: "blip.create", intervalMS: 60_000, search: page => e621.blips.search(page) },
    { name: "user_feedbacks", event: "user_feedback.create", intervalMS: 60_000, search: page => e621.userFeedbacks.search(page) },
    { name: "bans", event: "ban.create", intervalMS: 60_000, search: page => e621.bans.search(page) },
    { name: "takedowns", event: "takedown.create", intervalMS: 60_000, search: page => e621.takedowns.search(page), tracked: TRACKED.takedown },
    { name: "avoid_postings", event: "avoid_posting.create", intervalMS: 120_000, search: page => e621.avoidPostings.search(page) },
    { name: "avoid_posting_versions", event: "avoid_posting_version.create", intervalMS: 120_000, search: page => e621.avoidPostingVersions.search(page) },
    { name: "news_updates", event: "news_update.create", intervalMS: 120_000, search: page => e621.newsUpdates.search(page), tracked: TRACKED.newsUpdate },
];

const LIMIT = 320;
const MAX_PAGES_PER_POLL = 10;
// ids are assigned when a transaction starts, not when it commits, so rows can show up behind the cursor
const OVERLAP = 25;
// the largest b<id> e621 accepts
const MAX_ID = 2_147_483_647;

export class Feed {
    private cursor: number | null = null;
    private floor = 0;
    private seen = new Set<number>();
    constructor(readonly source: FeedSource) {}

    private async fetch(limit: number, page: Page["page"]): Promise<Array<Item>> {
        return await request(this.source.name, () => this.source.search({ limit, page })) ?? [];
    }

    private async init(): Promise<number> {
        const stored = await redis.hget(cursorKey, this.source.name);
        if (stored) {
            this.cursor = this.floor = Number(stored);
            return this.cursor;
        }
        // some endpoints don't sort by id by default (forum topics sort by last bump), b<id> always does
        const [latest] = await this.fetch(1, `b${MAX_ID}`);
        this.cursor = this.floor = latest?.id ?? 0;
        await redis.hset(cursorKey, this.source.name, String(this.cursor));
        Debug(`ingester:${this.source.name}`, `starting at id ${this.cursor}`);
        return this.cursor;
    }

    private trimSeen(): void {
        if (this.cursor === null) return;
        const floor = this.cursor - OVERLAP;
        if (floor <= this.floor) return;
        this.floor = floor;
        for (const id of this.seen) if (id <= floor) this.seen.delete(id);
    }

    async poll(): Promise<number> {
        let cursor = this.cursor ?? await this.init();
        let published = 0;
        for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
            const from = Math.max(page === 0 ? cursor - OVERLAP : cursor, 0);
            const items = await this.fetch(LIMIT, `a${from}`);
            items.sort((a, b) => a.id - b.id);
            for (const item of items) {
                if (item.id <= this.floor || this.seen.has(item.id)) continue;
                if (this.source.private?.(item)) {
                    this.seen.add(item.id);
                    continue;
                }
                const time = item.created_at ?? item.updated_at ?? new Date().toISOString();
                const derived = await this.source.derive?.(item);
                await publish(this.source.event, time, item);
                if (derived) await publish(derived, time, item);
                if (this.source.tracked) await remember(this.source.tracked, [item]);
                this.seen.add(item.id);
                published++;
            }
            const max = items.at(-1)?.id ?? cursor;
            if (max > cursor) {
                cursor = max;
                await redis.hset(cursorKey, this.source.name, String(cursor));
            }
            if (items.length < LIMIT) break;
        }
        this.cursor = cursor;
        this.trimSeen();
        return published;
    }
}
