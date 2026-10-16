import Debug from "@yiffy/debug";

import { cursorKey } from "../config.ts";
import { backfillQueue, e621, request } from "../e621.ts";
import { isPrivateSet, remember, TRACKED, type Item, type Tracked } from "../ingester/updates.ts";
import { count } from "../metrics.ts";
import redis from "../redis.ts";

import { getState, setState } from "./state.ts";

export interface Crawl {
    name: string;
    tracked: Tracked;
    private?(item: Item): boolean;
    search(page: { limit: number; page: `b${number}` }): Promise<Array<Item> | null>;
}

// smallest first
export const CRAWLS: Array<Crawl> = [
    { name: "news_updates", tracked: TRACKED.newsUpdate, search: page => e621.newsUpdates.search(page) },
    { name: "takedowns", tracked: TRACKED.takedown, search: page => e621.takedowns.search(page) },
    { name: "forum_topics", tracked: TRACKED.forumTopic, search: page => e621.forumTopics.search(page) },
    { name: "post_sets", tracked: TRACKED.postSet, private: isPrivateSet, search: page => e621.postSets.search(page) },
    { name: "forum_posts", tracked: TRACKED.forumPost, search: page => e621.forumPosts.search(page) },
    { name: "post_flags", tracked: TRACKED.postFlag, search: page => e621.postFlags.search(page) },
    { name: "comments", tracked: TRACKED.comment, search: page => e621.comments.search({ ...page, group_by: "comment" }) },
];

const LIMIT = 320;

/**
 * walks every record from `ceiling` down to the oldest, picking up where it left off. the ceiling is wherever the
 * create feed was when the crawl first started, the feed has been storing everything above it since, so the crawl
 * never goes back over records it's already getting
 *
 * resolves false if it can't start yet
 */
export async function crawl(source: Crawl): Promise<boolean> {
    const state = await getState(source.name);
    let ceiling = state?.ceiling ?? null;
    if (ceiling === null) {
        const feed = await redis.hget(cursorKey, source.name);
        if (!feed) {
            await setState(source.name, "crawl", { status: "waiting", detail: `waiting for the ${source.name} feed to start` });
            return false;
        }
        ceiling = Number(feed);
        await setState(source.name, "crawl", { ceiling, cursor: ceiling + 1 });
    }
    let cursor = state?.cursor ?? ceiling + 1;
    let stored = state?.stored ?? 0;
    await setState(source.name, "crawl", { status: "running", error: null, detail: null, started_at: state?.started_at ?? new Date() });
    Debug("backfill", `${source.name}: crawling down from id ${cursor - 1}`);
    for (;;) {
        const items = await request(`backfill ${source.name}`, () => source.search({ limit: LIMIT, page: `b${cursor}` }), backfillQueue) ?? [];
        count("requests.backfill");
        if (items.length === 0) break;
        const kept = source.private ? items.filter(item => !source.private!(item)) : items;
        await remember(source.tracked, kept);
        stored += kept.length;
        cursor = Math.min(...items.map(item => item.id));
        await setState(source.name, "crawl", { cursor, stored });
    }
    await setState(source.name, "crawl", { status: "done", cursor: 0, finished_at: new Date() });
    Debug("backfill", `${source.name}: done, ${stored} stored`);
    return true;
}
