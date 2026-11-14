import Debug from "@yiffy/debug";

import { cursorKey } from "../config.ts";
import { getSnapshots, putSnapshots } from "../db.ts";
import { e621, request } from "../e621.ts";
import { publish } from "../events.ts";
import { getRecovery, isActive } from "../recovery.ts";
import redis from "../redis.ts";

import type { Checkpoint } from "./recovery.ts";

export interface Post {
    approver_id: number | null;
    change_seq: number;
    comment_count: number;
    created_at: string;
    description: string;
    duration: number | null;
    fav_count: number;
    file: { ext: string; height: number; md5: string; size: number; width: number };
    flags: Record<string, boolean>;
    has_notes: boolean;
    id: number;
    locked_tags: Array<string>;
    pools: Array<number>;
    rating: string;
    relationships: { children: Array<number>; parent_id: number | null };
    score: PostScore;
    sources: Array<string>;
    tags: Record<string, Array<string>>;
    updated_at: string;
    uploader_id: number;
}

export interface PostScore { down: number; total: number; up: number }

export interface PostStats { comment_count: number; fav_count: number; score: PostScore }

// the full post is ~3x larger
export interface Snapshot extends Partial<PostStats> {
    approver_id: number | null;
    change_seq: number;
    children: Array<number>;
    description: string;
    flags: Record<string, boolean>;
    has_notes: boolean;
    locked_tags: Array<string>;
    md5: string;
    parent_id: number | null;
    pools: Array<number>;
    rating: string;
    sources: Array<string>;
    tags: Record<string, Array<string>>;
}

export type Changes = Record<string, { new: unknown; old: unknown } | { added: Array<unknown>; removed: Array<unknown> }>;

const LIMIT = 320;
const MAX_PAGES_PER_POLL = 20;
const NEW_POST_WINDOW_MS = 15 * 60 * 1000;
const UPDATED_FIELD = "posts:updated_at";
// order:updated isn't quite in order, the furthest out seen was about 19 seconds
const OVERLAP_MS = 30_000;
const MAX_ID_FIELD = "posts:max_id";
// e621 won't go past this page of numbered results
const MAX_PAGE = 750;
const MAX_POST_ID = 2_147_483_647;

async function search(tags: string, limit: number, page: number): Promise<Array<Post>> {
    return request("posts", () => e621.posts.search({ tags, limit, page })) as Promise<Array<unknown>> as Promise<Array<Post>>;
}

export function snapshot(post: Post): Snapshot {
    return {
        approver_id: post.approver_id,
        change_seq: post.change_seq,
        children: post.relationships.children,
        description: post.description,
        flags: post.flags,
        has_notes: post.has_notes,
        locked_tags: post.locked_tags,
        md5: post.file.md5,
        parent_id: post.relationships.parent_id,
        pools: post.pools,
        rating: post.rating,
        sources: post.sources,
        tags: post.tags,
        score: { up: post.score.up, down: post.score.down, total: post.score.total },
        fav_count: post.fav_count,
        comment_count: post.comment_count,
    };
}

export function statsDiff(before: Partial<PostStats>, after: PostStats): Changes | null {
    if (!before.score || before.fav_count === undefined || before.comment_count === undefined) return null;
    const changes: Changes = {};
    if (JSON.stringify(before.score) !== JSON.stringify(after.score)) changes.score = { old: before.score, new: after.score };
    if (before.fav_count !== after.fav_count) changes.fav_count = { old: before.fav_count, new: after.fav_count };
    if (before.comment_count !== after.comment_count) changes.comment_count = { old: before.comment_count, new: after.comment_count };
    return changes;
}

function setDiff<T>(before: Array<T>, after: Array<T>): { added: Array<T>; removed: Array<T> } | null {
    const a = new Set(before), b = new Set(after);
    const added = after.filter(v => !a.has(v)), removed = before.filter(v => !b.has(v));
    return added.length === 0 && removed.length === 0 ? null : { added, removed };
}

export function diff(before: Partial<Snapshot>, after: Snapshot): Changes {
    const changes: Changes = {};
    const scalar = (key: keyof Snapshot): void => {
        if (key in before && before[key] !== after[key]) changes[key] = { old: before[key], new: after[key] };
    };
    const set = <T>(key: string, a: Array<T>, b: Array<T>): void => {
        const d = setDiff(a, b);
        if (d) changes[key] = d;
    };

    // per category so moving a tag between categories (e.g. general -> artist) shows up
    if (before.tags) {
        for (const category of new Set([...Object.keys(before.tags), ...Object.keys(after.tags)])) {
            set(`tags.${category}`, before.tags[category] ?? [], after.tags[category] ?? []);
        }
    }
    for (const key of ["locked_tags", "sources", "pools", "children"] as const) {
        if (before[key]) set(key, before[key] as Array<unknown>, after[key] as Array<unknown>);
    }
    for (const key of ["rating", "description", "md5", "parent_id", "approver_id", "has_notes"] as const) scalar(key);
    if (before.flags) {
        for (const flag of new Set([...Object.keys(before.flags), ...Object.keys(after.flags)])) {
            if (before.flags[flag] !== after.flags[flag]) changes[`flags.${flag}`] = { old: before.flags[flag], new: after.flags[flag] };
        }
    }
    return changes;
}

/** where a posts recovery got to */
export interface PostsCheckpoint {
    events: number;
    page: number;
    /** id ranges still to go through, the first is the current one */
    ranges: Array<[number, number]>;
    /** how far back the current range has gotten, by updated_at */
    reached: string | null;
    /** the highest post id when it started, the ranges split up 1 to this */
    total: number;
    uploads: boolean;
}

export class PostsFeed {
    private cursor: number | null = null;
    private maxId = 0;
    readonly source = { name: "posts", intervalMS: 5000 } as const;

    private async init(): Promise<number> {
        const [updated, maxId] = await redis.hmget(cursorKey, [UPDATED_FIELD, MAX_ID_FIELD]);
        if (updated && maxId) {
            this.maxId = Number(maxId);
            return this.cursor = Number(updated);
        }
        // status:any is needed, deleted posts are invisible to every search otherwise
        const [byUpdate] = await search("order:updated status:any", 1, 1);
        this.cursor = byUpdate ? Date.parse(byUpdate.updated_at) : Date.now();
        if (!maxId) {
            const [byId] = await search("status:any", 1, 1);
            this.maxId = byId?.id ?? 0;
        } else {
            this.maxId = Number(maxId);
        }
        await redis.hset(cursorKey, { [UPDATED_FIELD]: String(this.cursor), [MAX_ID_FIELD]: String(this.maxId) });
        Debug("ingester:posts", `starting at ${new Date(this.cursor).toISOString()}, post id ${this.maxId}`);
        return this.cursor;
    }

    // compares posts against their snapshots, publishing whatever changed
    private async process(found: Array<Post>, isNewPost: (post: Post, before: Snapshot | null) => boolean): Promise<number> {
        if (found.length === 0) return 0;
        const posts = found.toSorted((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
        const previous = await getSnapshots("post", posts.map(p => p.id)) as Map<number, unknown> as Map<number, Snapshot>;
        const writes: Array<{ data: Snapshot; id: number; version: number }> = [];
        let published = 0;
        for (const post of posts) {
            const snap = snapshot(post);
            const before = previous.get(post.id) ?? null;
            const isNew = isNewPost(post, before);
            if (isNew) {
                await publish("post.create", post.created_at, { post });
                published++;
            } else if (before?.change_seq !== post.change_seq) {
                await publish("post.update", post.updated_at, { post, changes: before ? diff(before, snap) : null });
                published++;
            }
            const stats = before && !isNew ? statsDiff(before, snap as PostStats) : null;
            if (stats && Object.keys(stats).length !== 0) {
                await publish("post.stats", post.updated_at, { post_id: post.id, score: snap.score, fav_count: snap.fav_count, comment_count: snap.comment_count, changes: stats });
                published++;
            }
            if (!before || JSON.stringify(before) !== JSON.stringify(snap)) writes.push({ id: post.id, version: post.change_seq, data: snap });
        }
        await putSnapshots("post", writes);
        return published;
    }

    // uploads from the window that have been touched since (a vote is enough) are past `to` by updated_at, the live
    // feed already sent those as updates since they weren't new to it
    private async recoverUploads(from: number, to: number, created: Set<number>, stop: () => Promise<void>): Promise<number> {
        const uploads: Array<Post> = [];
        for (let before = MAX_POST_ID; ;) {
            await stop();
            const posts = await search(`status:any order:id_desc id:<${before}`, LIMIT, 1);
            for (const post of posts) {
                const at = Date.parse(post.created_at);
                if (at >= from && at <= to && !created.has(post.id)) uploads.push(post);
            }
            const oldest = posts.at(-1);
            if (posts.length < LIMIT || !oldest || Date.parse(oldest.created_at) < from) break;
            before = oldest.id;
        }
        uploads.reverse();
        const previous = await getSnapshots("post", uploads.map(post => post.id));
        for (const post of uploads) await publish("post.create", post.created_at, { post });
        await putSnapshots("post", uploads.filter(post => !previous.has(post.id)).map(post => ({ id: post.id, version: post.change_seq, data: snapshot(post) })));
        return uploads.length;
    }

    async poll(): Promise<number> {
        let cursor = this.cursor ?? await this.init();
        // a recovery going back over what we're behind on sends it anyway, so there's no catching up to do
        const recovery = await getRecovery();
        if (isActive(recovery) && recovery.sources.includes("posts") && Date.parse(recovery.from) <= cursor && Date.parse(recovery.to) > cursor) {
            Debug("ingester:posts", `recovery ${recovery.id} covers up to ${recovery.to}, skipping ahead`);
            cursor = this.cursor = Date.parse(recovery.to);
            await redis.hset(cursorKey, { [UPDATED_FIELD]: String(cursor) });
        }

        // updated_at also changes for votes, favorites and comments
        const since = cursor - OVERLAP_MS;
        // each page is handled as it comes in, holding every page of a big backlog at once ran the ingester out of memory
        const seen = new Set<number>();
        let newest = cursor, published = 0, caughtUp = false;
        for (let page = 1; page <= MAX_PAGES_PER_POLL && !caughtUp; page++) {
            const posts = await search("order:updated status:any", LIMIT, page);
            // posts shift down a page when others are updated while paging, the first copy is never older
            const fresh = posts.filter(post => Date.parse(post.updated_at) > since && !seen.has(post.id));
            for (const post of fresh) {
                seen.add(post.id);
                newest = Math.max(newest, Date.parse(post.updated_at));
            }
            // uploads can commit out of id order
            published += await this.process(fresh, (post, before) => {
                const isNew = !before && (post.id > this.maxId || Date.now() - Date.parse(post.created_at) < NEW_POST_WINDOW_MS);
                if (isNew && post.id > this.maxId) this.maxId = post.id;
                return isNew;
            });
            const oldest = posts.at(-1);
            if (posts.length < LIMIT || (oldest && Date.parse(oldest.updated_at) <= since)) caughtUp = true;
        }
        if (!caughtUp) Debug("ingester:posts", `more than ${MAX_PAGES_PER_POLL * LIMIT} updates since ${new Date(since).toISOString()}, some were skipped`);
        if (seen.size === 0) return 0;

        this.cursor = newest;
        await redis.hset(cursorKey, { [UPDATED_FIELD]: String(this.cursor), [MAX_ID_FIELD]: String(this.maxId) });
        return published;
    }

    // goes through every post updated between from and to. snapshots make anything already sent a no-op. there's only
    // MAX_PAGE pages of any search, a range of ids that has more updates than that is split in half
    // created is the posts that already have a post.create on the stream
    // its spot is saved after every page, so a restart carries on from there instead of starting over
    async recover(from: number, to: number, created: Set<number>, stop: () => Promise<void>, checkpoint: Checkpoint<PostsCheckpoint>): Promise<number> {
        let state = checkpoint.state;
        if (!state) {
            const [newest] = await search("status:any", 1, 1);
            if (!newest) return 0;
            state = { uploads: false, ranges: [[1, newest.id]], page: 1, reached: null, total: newest.id, events: 0 };
        } else {
            Debug("ingester:posts", `recovery: resuming ${state.ranges.length} range(s) at page ${state.page} of ${state.ranges[0]?.join("..") ?? "none"}`);
        }
        const save = async (s: PostsCheckpoint): Promise<void> => {
            const [range] = s.ranges;
            const detail = !s.uploads ? "uploads" : !range ? "finishing"
                : `ids ${range[0]}..${range[1]}${s.ranges.length > 1 ? ` (${s.ranges.length - 1} more after)` : ""}, page ${s.page}${s.reached ? `, back to ${s.reached}` : ""}`;
            // ids in ranges that are done, plus how far back in the window the current range has gotten
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

        // the first range is the one being gone through, splitting it puts both halves first so the order is the same
        while (state.ranges.length !== 0) {
            const [lo, hi] = state.ranges[0]!;
            let finished = false;
            for (; state.page <= MAX_PAGE && !finished; state.page++) {
                await stop();
                const posts = await search(`order:updated status:any id:${lo}..${hi}`, LIMIT, state.page);
                state.events += await this.process(posts.filter((post) => {
                    const at = Date.parse(post.updated_at);
                    return at > from && at <= to;
                }), (post, before) => !before && Date.parse(post.created_at) >= from);
                const oldest = posts.at(-1);
                finished = posts.length < LIMIT || !oldest || Date.parse(oldest.updated_at) <= from;
                // kept inside the window, the first pages are posts updated after it
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
