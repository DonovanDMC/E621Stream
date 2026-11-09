import Debug from "@yiffy/debug";

import { cursorKey, postSnapshotTTLSeconds, redisPrefix } from "../config.ts";
import { e621, request } from "../e621.ts";
import { publish } from "../events.ts";
import redis from "../redis.ts";

export interface Post {
    approver_id: number | null;
    change_seq: number;
    created_at: string;
    description: string;
    duration: number | null;
    file: { ext: string; height: number; md5: string; size: number; width: number };
    flags: Record<string, boolean>;
    has_notes: boolean;
    id: number;
    locked_tags: Array<string>;
    pools: Array<number>;
    rating: string;
    relationships: { children: Array<number>; parent_id: number | null };
    sources: Array<string>;
    tags: Record<string, Array<string>>;
    updated_at: string;
    uploader_id: number;
}

// only what's needed to tell what changed, the full post is ~3x larger
interface Snapshot {
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
const SEQ_FIELD = "posts:change_seq";
const MAX_ID_FIELD = "posts:max_id";
const snapshotKey = (id: number): string => `${redisPrefix}:post:${id}`;

async function search(tags: string, limit: number, page: number): Promise<Array<Post>> {
    return request("posts", () => e621.posts.search({ tags, limit, page })) as Promise<Array<unknown>> as Promise<Array<Post>>;
}

function snapshot(post: Post): Snapshot {
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
    };
}

function setDiff<T>(before: Array<T>, after: Array<T>): { added: Array<T>; removed: Array<T> } | null {
    const a = new Set(before), b = new Set(after);
    const added = after.filter(v => !a.has(v)), removed = before.filter(v => !b.has(v));
    return added.length === 0 && removed.length === 0 ? null : { added, removed };
}

export function diff(before: Snapshot, after: Snapshot): Changes {
    const changes: Changes = {};
    const scalar = (key: string, a: unknown, b: unknown): void => {
        if (a !== b) changes[key] = { old: a, new: b };
    };
    const set = <T>(key: string, a: Array<T>, b: Array<T>): void => {
        const d = setDiff(a, b);
        if (d) changes[key] = d;
    };

    // tags are reported per category so a category change (e.g. general -> artist) shows up as a move
    for (const category of new Set([...Object.keys(before.tags), ...Object.keys(after.tags)])) {
        set(`tags.${category}`, before.tags[category] ?? [], after.tags[category] ?? []);
    }
    set("locked_tags", before.locked_tags, after.locked_tags);
    set("sources", before.sources, after.sources);
    set("pools", before.pools, after.pools);
    set("children", before.children, after.children);
    scalar("rating", before.rating, after.rating);
    scalar("description", before.description, after.description);
    scalar("md5", before.md5, after.md5);
    scalar("parent_id", before.parent_id, after.parent_id);
    scalar("approver_id", before.approver_id, after.approver_id);
    scalar("has_notes", before.has_notes, after.has_notes);
    for (const flag of new Set([...Object.keys(before.flags), ...Object.keys(after.flags)])) {
        scalar(`flags.${flag}`, before.flags[flag], after.flags[flag]);
    }
    return changes;
}

export class PostsFeed {
    private maxId = 0;
    private seq: number | null = null;
    readonly source = { name: "posts", intervalMS: 5000 } as const;

    private async init(): Promise<number> {
        const [seq, maxId] = await redis.hmget(cursorKey, [SEQ_FIELD, MAX_ID_FIELD]);
        if (seq && maxId) {
            this.maxId = Number(maxId);
            return this.seq = Number(seq);
        }
        // status:any is required everywhere, deleted posts are otherwise invisible to every search, including these
        const [byChange] = await search("order:change status:any", 1, 1);
        const [byId] = await search("status:any", 1, 1);
        this.seq = byChange?.change_seq ?? 0;
        this.maxId = byId?.id ?? 0;
        await redis.hset(cursorKey, { [SEQ_FIELD]: String(this.seq), [MAX_ID_FIELD]: String(this.maxId) });
        Debug("ingester:posts", `starting at change_seq ${this.seq}, post id ${this.maxId}`);
        return this.seq;
    }

    async poll(): Promise<number> {
        const since = this.seq ?? await this.init();
        // newest change first, so walk back until we reach what was already handled
        const found = new Map<number, Post>();
        let caughtUp = false;
        for (let page = 1; page <= MAX_PAGES_PER_POLL && !caughtUp; page++) {
            const posts = await search("order:change status:any", LIMIT, page);
            for (const post of posts) {
                if (post.change_seq <= since) {
                    caughtUp = true;
                    break;
                }
                // the list can shift while paging, keep the newest copy of each post
                const existing = found.get(post.id);
                if (!existing || existing.change_seq < post.change_seq) found.set(post.id, post);
            }
            if (posts.length < LIMIT) caughtUp = true;
        }
        if (!caughtUp) Debug("ingester:posts", `more than ${MAX_PAGES_PER_POLL * LIMIT} changes since ${since}, some intermediate states were skipped`);
        if (found.size === 0) return 0;

        const posts = [...found.values()].sort((a, b) => a.change_seq - b.change_seq);
        const previous = await redis.mget(...posts.map(p => snapshotKey(p.id)));
        for (const [i, post] of posts.entries()) {
            const snap = snapshot(post);
            const before = previous[i] ? JSON.parse(previous[i]) as Snapshot : null;
            // uploads can commit out of id order, so a recent post we've never seen is also treated as new
            const isNew = !before && (post.id > this.maxId || Date.now() - Date.parse(post.created_at) < NEW_POST_WINDOW_MS);
            if (isNew) {
                if (post.id > this.maxId) this.maxId = post.id;
                await publish("post.create", post.created_at, { post });
            } else {
                // null means we haven't seen this post before (or its snapshot expired), so we can't say what changed
                const changes = before ? diff(before, snap) : null;
                await publish("post.update", post.updated_at, { post, changes });
            }
            await redis.set(snapshotKey(post.id), JSON.stringify(snap), "EX", postSnapshotTTLSeconds);
        }

        this.seq = posts.at(-1)!.change_seq;
        await redis.hset(cursorKey, { [SEQ_FIELD]: String(this.seq), [MAX_ID_FIELD]: String(this.maxId) });
        return posts.length;
    }
}
