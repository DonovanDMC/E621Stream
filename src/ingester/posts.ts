import Debug from "@yiffy/debug";

import { cursorKey } from "../config.ts";
import { getSnapshots, putSnapshots } from "../db.ts";
import { e621, request } from "../e621.ts";
import { publish } from "../events.ts";
import redis from "../redis.ts";

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

    async poll(): Promise<number> {
        const cursor = this.cursor ?? await this.init();
        // updated_at also changes for votes, favorites and comments
        const since = cursor - OVERLAP_MS;
        const found = new Map<number, Post>();
        let caughtUp = false;
        for (let page = 1; page <= MAX_PAGES_PER_POLL && !caughtUp; page++) {
            const posts = await search("order:updated status:any", LIMIT, page);
            for (const post of posts) {
                const existing = found.get(post.id);
                if (Date.parse(post.updated_at) > since && (!existing || existing.updated_at < post.updated_at)) found.set(post.id, post);
            }
            const oldest = posts.at(-1);
            if (posts.length < LIMIT || (oldest && Date.parse(oldest.updated_at) <= since)) caughtUp = true;
        }
        if (!caughtUp) Debug("ingester:posts", `more than ${MAX_PAGES_PER_POLL * LIMIT} updates since ${new Date(since).toISOString()}, some were skipped`);
        if (found.size === 0) return 0;

        const posts = [...found.values()].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
        const previous = await getSnapshots("post", posts.map(p => p.id)) as Map<number, unknown> as Map<number, Snapshot>;
        const writes: Array<{ data: Snapshot; id: number; version: number }> = [];
        let published = 0;
        for (const post of posts) {
            const snap = snapshot(post);
            const before = previous.get(post.id) ?? null;
            // uploads can commit out of id order
            const isNew = !before && (post.id > this.maxId || Date.now() - Date.parse(post.created_at) < NEW_POST_WINDOW_MS);
            if (isNew) {
                if (post.id > this.maxId) this.maxId = post.id;
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

        this.cursor = Math.max(cursor, ...posts.map(post => Date.parse(post.updated_at)));
        await redis.hset(cursorKey, { [UPDATED_FIELD]: String(this.cursor), [MAX_ID_FIELD]: String(this.maxId) });
        return published;
    }
}
