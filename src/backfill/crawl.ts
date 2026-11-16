import Debug from "@yiffy/debug";

import { cursorKey } from "../config.ts";
import { backfillQueue, e621, request } from "../e621.ts";
import { isPrivateSet, remember, TRACKED, type Item, type Tracked } from "../ingester/updates.ts";
import { count } from "../metrics.ts";
import redis from "../redis.ts";

import { getState, setLanes, setState, type Lane } from "./state.ts";

// crawls page back through an endpoint from its feed's cursor down to id 0 and snapshot everything, for resources that
// aren't in the db exports. the feed handles everything above the cursor, so between them nothing's missed
// the id range is split into lanes that go at the same time, each picks up where it left off after a restart
// it all goes through the background queue, so it only gets requests the live feeds aren't using

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
// the next page depends on the last one, so each lane only has one request out at a time
const LANES = 2;

// LANES equal slices of 0..top, highest first
export function split(top: number): Array<Lane> {
    const size = Math.ceil(top / LANES);
    return Array.from({ length: LANES }, (_, i) => ({ cursor: top - i * size, lower: Math.max(0, top - (i + 1) * size) })).filter(lane => lane.cursor > lane.lower);
}

const remaining = (lanes: Array<Lane>): number => lanes.reduce((total, lane) => total + Math.max(0, lane.cursor - lane.lower), 0);

// false if its feed hasn't started yet
export async function crawl(source: Crawl): Promise<boolean> {
    const state = await getState(source.name);
    let ceiling = state?.ceiling ?? null;
    if (ceiling === null) {
        // the feed's cursor at the time is where the crawl starts, it's fixed from then on
        const feed = await redis.hget(cursorKey, source.name);
        if (!feed) {
            await setState(source.name, "crawl", { status: "waiting", detail: `waiting for the ${source.name} feed to start` });
            return false;
        }
        ceiling = Number(feed);
        await setState(source.name, "crawl", { ceiling, cursor: ceiling + 1 });
    }
    // crawls from before lanes were added only have `cursor`
    const lanes = state?.lanes ?? split(state?.cursor ?? ceiling + 1);
    let stored = state?.stored ?? 0;
    const save = (): Promise<void> => setLanes(source.name, lanes, { cursor: remaining(lanes), stored });
    await setState(source.name, "crawl", { status: "running", error: null, detail: null, started_at: state?.started_at ?? new Date() });
    await save();
    Debug("backfill", `${source.name}: crawling ${lanes.map(lane => `${lane.cursor - 1}..${lane.lower}`).join(", ")}`);

    await Promise.all(lanes.map(async (lane) => {
        while (lane.cursor > lane.lower) {
            const items = await request(`backfill ${source.name}`, () => source.search({ limit: LIMIT, page: `b${lane.cursor}` }), backfillQueue) ?? [];
            count("requests.backfill");
            // anything below lower belongs to the next lane
            const mine = items.filter(item => item.id >= lane.lower);
            const kept = source.private ? mine.filter(item => !source.private!(item)) : mine;
            await remember(source.tracked, kept);
            stored += kept.length;
            // the lowest id on the page, or done if the page was empty or went past lower
            lane.cursor = mine.length === items.length && items.length !== 0 ? Math.min(...items.map(item => item.id)) : lane.lower;
            await save();
        }
    }));
    await setState(source.name, "crawl", { status: "done", cursor: 0, finished_at: new Date() });
    Debug("backfill", `${source.name}: done, ${stored} stored`);
    return true;
}
