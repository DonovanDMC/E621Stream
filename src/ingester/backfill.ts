import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import IngesterConfig from "../config/IngesterConfig.ts";
import Backfill, { type BackfillAttributes, type Lane } from "../db/models/Backfill.ts";
import PostVersionIndex from "../db/models/PostVersionIndex.ts";
import Redis from "../db/Redis.ts";
import { saveSnapshots, type SnapshotResourceType, type SnapshotTypeMap } from "../gateway/snapshots.ts";
import { backfillQueue, e621, request } from "../util/e621.ts";
import { count } from "../util/metrics.ts";

import { isPrivateSet } from "./feeds.ts";
import { searchPosts } from "./tagCategories.ts";

import type * as E621 from "e621-openapi/types";

const cursorKey = `${Config.redisPrefix}cursors`;
const LIMIT = 320;
const LANES = 2;
const RETRY_MS = 5 * 60_000;
const IDLE_MS = 60 * 60_000;

interface Item { id: number }
export interface Crawl {
    /** The feed's cursor, everything after it is the feed's to store */
    cursor: string;
    name: string;
    /** Its search makes its own requests through the backfill queue, rather than being run inside one */
    ownRequests?: boolean;
    /** The snapshots it fills, ones stored somewhere else don't have one */
    resource?: SnapshotResourceType;
    private?(item: Item): boolean;
    save(items: Array<Item>): Promise<void>;
    search(page: { limit: number; page: `b${number}` }): Promise<Array<Item>>;
}

interface SnapshotCrawl<R extends SnapshotResourceType> {
    cursor: string;
    name: string;
    ownRequests?: boolean;
    resource: R;
    private?(item: SnapshotTypeMap[R]): boolean;
    search(page: { limit: number; page: `b${number}` }): Promise<Array<SnapshotTypeMap[R]>>;
}

// most are stored as snapshots
const crawl = <R extends SnapshotResourceType>(source: SnapshotCrawl<R>): Crawl => ({ ...source, save: async items => saveSnapshots(source.resource, items as Array<SnapshotTypeMap[R]>) });

// every resource something is built from, straight from the api so they're the same as what it returns
export const CRAWLS: Array<Crawl> = [
    // first, posts are fetched basic once every tag is here to put theirs in categories
    crawl({ name: "tags", resource: "tag", cursor: "tags", search: page => e621.tags.search(page) }),
    crawl({ name: "posts", resource: "post", cursor: "posts:max_id", ownRequests: true, search: async page => searchPosts("backfill posts", { ...page, tags: "status:any" }, backfillQueue) }),
    crawl({ name: "comments", resource: "comment", cursor: "comments", search: page => e621.comments.search({ ...page, group_by: "comment" }) }),
    crawl({ name: "forum_posts", resource: "forum_post", cursor: "forum_posts", search: page => e621.forumPosts.search(page) }),
    crawl({ name: "forum_topics", resource: "forum_topic", cursor: "forum_topics", search: page => e621.forumTopics.search(page) }),
    crawl({ name: "post_sets", resource: "post_set", cursor: "post_sets", private: isPrivateSet, search: page => e621.postSets.search(page) }),
    crawl({ name: "post_flags", resource: "post_flag", cursor: "post_flags", search: page => e621.postFlags.search(page) }),
    crawl({ name: "post_replacements", resource: "post_replacement", cursor: "post_replacements", search: page => e621.postReplacements.search(page) }),
    crawl({ name: "takedowns", resource: "takedown", cursor: "takedowns", search: page => e621.takedowns.search(page) }),
    crawl({ name: "news_updates", resource: "news_update", cursor: "news_updates", search: page => e621.newsUpdates.search(page) }),
    crawl({ name: "tag_aliases", resource: "tag_alias", cursor: "tag_aliases", search: page => e621.tagAliases.search(page) }),
    crawl({ name: "tag_implications", resource: "tag_implication", cursor: "tag_implications", search: page => e621.tagImplications.search(page) }),
    crawl({ name: "bulk_update_requests", resource: "bulk_update_request", cursor: "bulk_update_requests", search: page => e621.bulkUpdateRequests.search(page) }),
    crawl({ name: "notes", resource: "note", cursor: "notes", search: page => e621.notes.search(page) }),
    crawl({ name: "pools", resource: "pool", cursor: "pools", search: page => e621.pools.search(page) }),
    crawl({ name: "wiki_pages", resource: "wiki_page", cursor: "wiki_pages", search: page => e621.wikiPages.search(page) }),
    crawl({ name: "artists", resource: "artist", cursor: "artists", search: page => e621.artists.search(page) }),
    crawl({ name: "artist_urls", resource: "artist_url", cursor: "artist_urls", search: page => e621.artistUrls.search(page) }),
    crawl({ name: "avoid_postings", resource: "avoid_posting", cursor: "avoid_postings", search: page => e621.avoidPostings.search(page) }),
    crawl({ name: "user_feedbacks", resource: "user_feedback", cursor: "user_feedbacks", search: page => e621.userFeedbacks.search(page) }),
    crawl({ name: "bans", resource: "ban", cursor: "bans", search: page => e621.bans.search(page) }),
    crawl({ name: "blips", resource: "blip", cursor: "blips", search: page => e621.blips.search(page) }),
    crawl({ name: "users", resource: "user", cursor: "users", search: page => e621.users.search(page) }),
    // the e621 client's mod actions don't tie each action to its values like e621-openapi's do
    crawl({ name: "mod_actions", resource: "mod_action", cursor: "mod_actions", search: async page => await e621.modActions.search(page) as unknown as Array<SnapshotTypeMap["mod_action"]> }),
    // only which version each one is, for post version mod actions. there's too many of them to keep whole
    { name: "post_versions", cursor: "post_versions", search: page => e621.postVersions.search(page), save: async items => PostVersionIndex.remember(items as Array<E621.PostVersion>) },
];

async function setState(source: string, patch: Partial<BackfillAttributes>): Promise<Backfill> {
    const state = await Backfill.find(source) ?? new Backfill({ source, kind: "crawl" });
    Object.assign(state, patch);
    return state.save();
}

// split so the lanes can go at once, each from its cursor down to its lower bound
function split(top: number): Array<Lane> {
    const size = Math.ceil(top / LANES);
    return Array.from({ length: LANES }, (_, i) => ({ cursor: top - (i * size), lower: Math.max(0, top - ((i + 1) * size)) })).filter(lane => lane.cursor > lane.lower);
}

const remaining = (lanes: Array<Lane>): number => lanes.reduce((total, lane) => total + Math.max(0, lane.cursor - lane.lower), 0);

/** Stores everything from before the feed started, newest first. false when it has to wait for the feed */
async function run(source: Crawl): Promise<boolean> {
    const state = await Backfill.find(source.name);
    if (state?.status === "done") return true;
    let ceiling = state?.ceiling ?? null;
    if (ceiling === null) {
        const feed = await Redis.hget(cursorKey, source.cursor);
        if (!feed) {
            await setState(source.name, { status: "waiting", detail: `waiting for the ${source.name} feed to start` });
            return false;
        }
        ceiling = Number(feed);
    }
    const lanes = state?.lanes ?? split(ceiling + 1);
    let stored = state?.stored ?? 0;
    await setState(source.name, { status: "running", ceiling, lanes, cursor: remaining(lanes), error: null, detail: null, started_at: state?.started_at ?? new Date() });
    Debug("backfill", `${source.name}: crawling ${lanes.map(lane => `${lane.cursor - 1}..${lane.lower}`).join(", ")}`);

    await Promise.all(lanes.map(async (lane) => {
        while (lane.cursor > lane.lower) {
            const page = { limit: LIMIT, page: `b${lane.cursor}` as const };
            const items = source.ownRequests ? await source.search(page) : await request(`backfill ${source.name}`, () => source.search(page), backfillQueue);
            count("requests.backfill");
            const mine = items.filter(item => item.id >= lane.lower);
            const kept = mine.filter(item => !source.private?.(item));
            await source.save(kept);
            stored += kept.length;
            // a page that went past the lower bound, or came back empty, is the end of the lane
            lane.cursor = mine.length === items.length && items.length !== 0 ? Math.min(...items.map(item => item.id)) : lane.lower;
            await setState(source.name, { lanes, cursor: remaining(lanes), stored });
        }
    }));
    await setState(source.name, { status: "done", cursor: 0, finished_at: new Date() });
    Debug("backfill", `${source.name}: done, ${stored} stored`);
    return true;
}

/** false when it isn't done, and should be tried again later */
export async function runBackfill(source: Crawl): Promise<boolean> {
    const start = Date.now();
    try {
        if (!await run(source)) return false;
        Debug("backfill", `${source.name} finished in ${Math.round((Date.now() - start) / 1000)}s`);
        return true;
    } catch (err) {
        Debug("backfill", `${source.name} failed, trying again in ${RETRY_MS / 60_000} minutes: ${String(err)}`);
        await setState(source.name, { status: "failed", error: String(err) }).catch(() => null);
        return false;
    }
}

// one at a time, the backfill queue only gets what the feeds leave over anyway
export function startBackfill(): void {
    const sources = CRAWLS.filter(source => !IngesterConfig.disabledSources.includes(source.name));
    void (async (): Promise<never> => {
        for (const source of sources) await setState(source.name, {}).catch(() => null);
        for (;;) {
            let pending = false;
            for (const source of sources) if (!await runBackfill(source)) pending = true;
            await Bun.sleep(pending ? RETRY_MS : IDLE_MS);
        }
    })();
}
