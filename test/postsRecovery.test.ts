import { expect, mock, test } from "bun:test";

import * as db from "../src/db.ts";
import * as e621Module from "../src/e621.ts";
import * as events from "../src/events.ts";

// 1000 posts, one updated every minute, so a page of 320 is about 5 hours
const from = Date.parse("2026-11-14T00:00:00Z"), to = from + 600 * 60_000;
const posts = Array.from({ length: 1000 }, (_, i) => ({
    id: i + 1,
    change_seq: i + 1,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: new Date(from - 200 * 60_000 + i * 60_000).toISOString(),
    approver_id: null, comment_count: 0, description: "", duration: null, fav_count: 0, has_notes: false, locked_tags: [], pools: [], rating: "s", sources: [], uploader_id: 1,
    file: { ext: "png", height: 1, md5: `md5-${i}`, size: 1, width: 1 },
    flags: {}, relationships: { children: [], parent_id: null }, score: { down: 0, total: 0, up: 0 }, tags: { general: [] },
}));

// what e621 would return for the searches the recovery makes
function search({ tags, limit, page }: { limit: number; page: number; tags: string }): Array<typeof posts[number]> {
    if (tags === "status:any") return posts.toSorted((a, b) => b.id - a.id).slice(0, limit);
    if (tags.startsWith("status:any order:id_desc")) return [];
    const [, lo, hi] = /id:(\d+)\.\.(\d+)/.exec(tags)!;
    const matching = posts.filter(p => p.id >= Number(lo) && p.id <= Number(hi)).toSorted((a, b) => b.updated_at.localeCompare(a.updated_at));
    return matching.slice((page - 1) * limit, page * limit);
}

let searches = 0;
const snapshots = new Map<number, Record<string, unknown>>();
const published: Array<number> = [];
type Post = typeof posts[number];
interface Write { data: Record<string, unknown>; id: number }

const fakeSearch = (options: Parameters<typeof search>[0]): Array<Post> => {
    searches++;
    return search(options);
};
const getSnapshots = async (_: string, ids: Array<number>): Promise<Map<number, Record<string, unknown>>> => new Map(ids.filter(id => snapshots.has(id)).map(id => [id, snapshots.get(id)!]));
const putSnapshots = async (_: string, writes: Array<Write>): Promise<void> => {
    for (const w of writes) snapshots.set(w.id, w.data);
};
const publish = async (_: string, __: string, data: { post: { id: number } }): Promise<string> => {
    published.push(data.post.id);
    return "0-0";
};
await mock.module("../src/e621.ts", () => ({ ...e621Module, request: async (_: string, fn: () => Promise<unknown>): Promise<unknown> => fn(), e621: { posts: { search: fakeSearch } } }));
await mock.module("../src/db.ts", () => ({ ...db, getSnapshots, putSnapshots }));
await mock.module("../src/events.ts", () => ({ ...events, publish }));

const { PostsFeed } = await import("../src/ingester/posts.ts");
type PostsCheckpoint = import("../src/ingester/posts.ts").PostsCheckpoint;

test("a posts recovery carries on from its checkpoint", async () => {
    let saved: PostsCheckpoint | undefined, fraction = 0;
    const checkpoint = {
        get state(): PostsCheckpoint | undefined {
            return saved;
        },
        save: async (state: PostsCheckpoint, progress: { fraction: number }): Promise<void> => {
            saved = structuredClone(state);
            fraction = progress.fraction;
        },
    };

    // stopped once the uploads and two pages are done, like a restart
    let stops = 0;
    const stopEarly = async (): Promise<void> => {
        if (++stops > 3) throw new Error("restart");
    };
    let error: unknown;
    try {
        await new PostsFeed().recover(from, to, new Set(), stopEarly, checkpoint);
    } catch (err) {
        error = err;
    }
    expect(String(error)).toContain("restart");
    expect(saved?.page).toBe(3);
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);

    const before = searches;
    const events = await new PostsFeed().recover(from, to, new Set(), async () => {}, checkpoint);
    // only the page that was left, not the whole window again
    expect(searches - before).toBe(1);
    expect(fraction).toBe(1);

    // everything updated in the window, sent once between the two runs
    const inWindow = posts.filter(p => Date.parse(p.updated_at) > from && Date.parse(p.updated_at) <= to).map(p => p.id);
    expect(published.toSorted((a, b) => a - b)).toEqual(inWindow);
    expect(events).toBe(inWindow.length);
});
