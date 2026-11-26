import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import PostVersionIndex from "../db/models/PostVersionIndex.ts";
import Redis from "../db/Redis.ts";
import { publish, type EventContext } from "../gateway/events.ts";
import { getRecovery, isActive } from "../gateway/recovery.ts";
import { getSnapshots, saveSnapshots } from "../gateway/snapshots.ts";
import { e621, request } from "../util/e621.ts";

import { searchPosts } from "./tagCategories.ts";

import type { PollResult } from "./feedLog.ts";
import type { Checkpoint } from "./recovery.ts";
import type * as E621 from "e621-openapi/types";

const cursorKey = `${Config.redisPrefix}cursors`;
const UPDATED_FIELD = "posts:updated_at";
const MAX_ID_FIELD = "posts:max_id";
const LIMIT = 320;
const MAX_PAGES_PER_POLL = 20;
// uploads can commit out of id order, so a post we haven't seen this new is still a create
const NEW_POST_WINDOW_MS = 15 * 60 * 1000;
// order:updated isn't quite in order, the furthest out seen was about 19 seconds
const OVERLAP_MS = 30_000;
const MAX_PAGE = 750;
const PROBE_PAGE = 600;
const MAX_POST_ID = 2_147_483_647;

// a/b id paging doesn't work with order: tags, so these are numbered pages.
// status:any is needed, deleted posts are invisible to every search otherwise
async function search(tags: string, limit: number, page: number): Promise<Array<E621.ExtendedPost>> {
    return searchPosts("posts", { tags: `${tags} status:any`, limit, page });
}

// a post's updated_at and its newest version are from the same save
const VERSION_SLACK_MS = 2000;
const VERSION_LOOKUP_POSTS = 50;
const VERSION_LOOKUP_LIMIT = 320;
// versions this far behind the versions feed are looked at too, it can be a poll behind
const VERSION_LOOKUP_MARGIN = 5000;

// edits make a post version, which says who made them. changes that aren't edits, like approvals, don't have one.
// the posts feed often gets to a post before the versions feed does, so versions newer than the feed's are fetched then,
// many posts to a search. anything older the feed already has, a vote or favorite also moves updated_at, and looking those
// up one post at a time used most of the rate limit
async function rememberVersions(posts: Array<E621.ExtendedPost>): Promise<void> {
    const missing: Array<number> = [];
    for (const post of posts) {
        if (!await PostVersionIndex.madeAt(post.id, post.updated_at, VERSION_SLACK_MS)) missing.push(post.id);
    }
    const feed = Number(await Redis.hget(cursorKey, "post_versions"));
    if (missing.length === 0 || !feed) return;
    for (let i = 0; i < missing.length; i += VERSION_LOOKUP_POSTS) {
        const ids = missing.slice(i, i + VERSION_LOOKUP_POSTS);
        // post_id takes a comma separated list, though it's typed as one id
        await PostVersionIndex.remember(await request("post_versions for posts", () => e621.postVersions.search({ post_id: ids.join(",") as unknown as number, id: `>${feed - VERSION_LOOKUP_MARGIN}`, limit: VERSION_LOOKUP_LIMIT })));
    }
}

async function updaterOf(post: E621.ExtendedPost): Promise<EventContext | undefined> {
    const version = await PostVersionIndex.madeAt(post.id, post.updated_at, VERSION_SLACK_MS);
    return version ? { updater_id: version.updater_id } : undefined;
}

const statsChanged = (before: E621.Post, after: E621.Post): boolean => before.stats.fav_count !== after.stats.fav_count
    || before.stats.comment_count !== after.stats.comment_count
    || JSON.stringify(before.stats.score) !== JSON.stringify(after.stats.score);

export const POSTS_SOURCE = { name: "posts", intervalMS: 5000 } as const;

export interface PostsCheckpoint {
    events: number;
    page: number;
    ranges: Array<[number, number]>;
    reached: string | null; // ISO timestamp
    total: number;
    uploads: boolean;
}

/** Follows posts by updated_at, which also changes for votes, favorites and comments */
export class PostsFeed {
    private cursor: number | null = null;
    private maxID = 0;
    readonly source = POSTS_SOURCE;

    private async init(): Promise<number> {
        const [updated, maxID] = await Redis.hmget(cursorKey, [UPDATED_FIELD, MAX_ID_FIELD]);
        if (updated && maxID) {
            this.maxID = Number(maxID);
            return this.cursor = Number(updated);
        }
        const [byUpdate] = await search("order:updated", 1, 1);
        this.cursor = byUpdate ? Date.parse(byUpdate.updated_at) : Date.now();
        if (maxID) {
            this.maxID = Number(maxID);
        } else {
            const [byID] = await search("", 1, 1);
            this.maxID = byID?.id ?? 0;
        }
        await Redis.hset(cursorKey, { [UPDATED_FIELD]: String(this.cursor), [MAX_ID_FIELD]: String(this.maxID) });
        Debug("ingester:posts", `starting at ${new Date(this.cursor).toISOString()}, post id ${this.maxID}`);
        return this.cursor;
    }

    private async process(found: Array<E621.ExtendedPost>, isNewPost: (post: E621.ExtendedPost, stored: boolean) => boolean): Promise<number> {
        if (found.length === 0) return 0;
        const posts = found.toSorted((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
        const stored = await getSnapshots("post", posts.map(post => post.id));
        await rememberVersions(posts.filter((post) => {
            const before = stored.get(post.id);
            return before !== undefined && before.version !== post.change_seq && !isNewPost(post, true);
        }));
        const writes: Array<E621.ExtendedPost> = [];
        let published = 0;
        for (const post of posts) {
            const before = stored.get(post.id);
            const isNew = isNewPost(post, before !== undefined);
            const changed = before?.version !== post.change_seq;
            const stats = before !== undefined && !isNew && statsChanged(before.data, post);
            if (isNew) {
                await publish("post.create", post.created_at, post);
                published++;
            } else if (changed) {
                await publish("post.update", post.updated_at, post, await updaterOf(post));
                published++;
            }
            if (stats) {
                await publish("post.stats", post.updated_at, post);
                published++;
            }
            if (!before || changed || stats) writes.push(post);
        }
        await saveSnapshots("post", writes);
        return published;
    }

    private async recoverUploads(from: number, to: number, created: Array<number>, stop: () => Promise<void>): Promise<number> {
        const uploads: Array<E621.ExtendedPost> = [];
        for (let before = MAX_POST_ID; ;) {
            await stop();
            const posts = await search(`order:id_desc id:<${before}`, LIMIT, 1);
            for (const post of posts) {
                const at = Date.parse(post.created_at);
                if (at >= from && at <= to && !created.includes(post.id)) uploads.push(post);
            }
            const oldest = posts.at(-1);
            if (posts.length < LIMIT || !oldest || Date.parse(oldest.created_at) < from) break;
            before = oldest.id;
        }
        uploads.reverse();
        const stored = await getSnapshots("post", uploads.map(post => post.id));
        for (const post of uploads) await publish("post.create", post.created_at, post);
        await saveSnapshots("post", uploads.filter(post => !stored.has(post.id)));
        return uploads.length;
    }

    async poll(): Promise<PollResult> {
        let cursor = this.cursor ?? await this.init();
        // a recovery that covers where we are sends it, so there's no reason to go over it twice
        const recovery = await getRecovery();
        if (isActive(recovery) && recovery.sources.includes("posts") && Date.parse(recovery.from) <= cursor && Date.parse(recovery.to) > cursor) {
            Debug("ingester:posts", `recovery ${recovery.id} covers up to ${recovery.to}, skipping ahead`);
            cursor = this.cursor = Date.parse(recovery.to);
            await Redis.hset(cursorKey, { [UPDATED_FIELD]: String(cursor) });
        }

        const since = cursor - OVERLAP_MS;
        // each page is handled as it comes in, holding every page of a big backlog at once ran the ingester out of memory
        const seen: Array<number> = [];
        let newest = cursor, oldest = Infinity, published = 0, caughtUp = false;
        for (let page = 1; page <= MAX_PAGES_PER_POLL && !caughtUp; page++) {
            const posts = await search("order:updated", LIMIT, page);
            const fresh = posts.filter(post => Date.parse(post.updated_at) > since && !seen.includes(post.id));
            for (const post of fresh) {
                seen.push(post.id);
                newest = Math.max(newest, Date.parse(post.updated_at));
                oldest = Math.min(oldest, Date.parse(post.updated_at));
            }
            published += await this.process(fresh, (post, stored) => {
                const isNew = !stored && (post.id > this.maxID || Date.now() - Date.parse(post.created_at) < NEW_POST_WINDOW_MS);
                if (isNew && post.id > this.maxID) this.maxID = post.id;
                return isNew;
            });
            const last = posts.at(-1);
            if (posts.length < LIMIT || (last && Date.parse(last.updated_at) <= since)) caughtUp = true;
        }
        const skipped = caughtUp || oldest === Infinity ? undefined : { from: since, to: oldest };
        if (skipped) Debug("ingester:posts", `more than ${MAX_PAGES_PER_POLL * LIMIT} updates since ${new Date(since).toISOString()}, some were skipped`);
        if (seen.length === 0) return { published: 0 };

        this.cursor = newest;
        await Redis.hset(cursorKey, { [UPDATED_FIELD]: String(this.cursor), [MAX_ID_FIELD]: String(this.maxID) });
        return { published, skipped };
    }

    // order:updated only goes 750 pages deep, so busy id ranges are split until each fits
    async recover(from: number, to: number, created: Array<number>, stop: () => Promise<void>, checkpoint: Checkpoint<PostsCheckpoint>): Promise<number> {
        let state = checkpoint.state;
        if (state) {
            Debug("ingester:posts", `recovery: resuming ${state.ranges.length} range(s) at page ${state.page} of ${state.ranges[0]?.join("..") ?? "none"}`);
        } else {
            const [newest] = await search("", 1, 1);
            if (!newest) return 0;
            state = { uploads: false, ranges: [[1, newest.id]], page: 1, reached: null, total: newest.id, events: 0 };
        }
        const save = async (s: PostsCheckpoint): Promise<void> => {
            const [range] = s.ranges;
            const detail = !s.uploads ? "uploads" : range
                ? `ids ${range[0]}..${range[1]}${s.ranges.length > 1 ? ` (${s.ranges.length - 1} more after)` : ""}, page ${s.page}${s.reached ? `, back to ${s.reached}` : ""}`
                : "finishing";
            const left = s.ranges.reduce((total, [lo, hi]) => total + hi - lo + 1, 0);
            const current = range && s.reached ? (range[1] - range[0] + 1) * (to - Date.parse(s.reached)) / (to - from) : 0;
            const fraction = s.uploads ? Math.min(1, Math.max(0, (s.total - left + current) / s.total)) : 0;
            await checkpoint.save(s, { detail, events: s.events, fraction });
        };
        if (!state.uploads) {
            await save(state);
            state.events += await this.recoverUploads(from, to, created, stop);
            state.uploads = true;
            await save(state);
        }

        while (state.ranges.length !== 0) {
            const [lo, hi] = state.ranges[0]!;
            if (state.page === 1 && lo !== hi) {
                await stop();
                const probe = await search(`order:updated id:${lo}..${hi}`, LIMIT, PROBE_PAGE);
                const oldest = probe.at(-1);
                if (probe.length === LIMIT && oldest && Date.parse(oldest.updated_at) > from) {
                    const mid = Math.floor((lo + hi) / 2);
                    Debug("ingester:posts", `recovery: ${lo}..${hi} has more than ${PROBE_PAGE} pages of updates, splitting`);
                    state.ranges.splice(0, 1, [lo, mid], [mid + 1, hi]);
                    await save(state);
                    continue;
                }
            }
            let finished = false;
            for (; state.page <= MAX_PAGE && !finished; state.page++) {
                await stop();
                const posts = await search(`order:updated id:${lo}..${hi}`, LIMIT, state.page);
                state.events += await this.process(posts.filter((post) => {
                    const at = Date.parse(post.updated_at);
                    return at > from && at <= to;
                }), (post, stored) => !stored && Date.parse(post.created_at) >= from);
                const oldest = posts.at(-1);
                finished = posts.length < LIMIT || !oldest || Date.parse(oldest.updated_at) <= from;
                if (oldest) state.reached = new Date(Math.min(to, Math.max(from, Date.parse(oldest.updated_at)))).toISOString();
                await save({ ...state, page: state.page + 1 });
            }
            if (finished || lo === hi) {
                if (!finished) Debug("ingester:posts", `post ${lo} has more than ${MAX_PAGE} pages of updates, somehow`);
                state.ranges.shift();
            } else {
                const mid = Math.floor((lo + hi) / 2);
                Debug("ingester:posts", `recovery: too many updates in ${lo}..${hi}, splitting`);
                state.ranges.splice(0, 1, [lo, mid], [mid + 1, hi]);
            }
            state.page = 1;
            state.reached = null;
            await save(state);
        }
        return state.events;
    }
}
