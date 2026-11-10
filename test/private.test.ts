import { describe, expect, test } from "bun:test";

import { privateSets, type PrivateEvent } from "../src/gateway/private.ts";

interface FakeSet { id: number; is_public: boolean; post_ids: Array<number>; updated_at: string }

const hash = new Map<string, string>();
const store = {
    send(command: string, args: Array<string>): Promise<unknown> {
        const fields = args.slice(1);
        if (command === "HGETALL") return Promise.resolve(Object.fromEntries(hash));
        if (command === "HSET") for (let i = 0; i < fields.length; i += 2) hash.set(fields[i]!, fields[i + 1]!);
        if (command === "HDEL") for (const field of fields) hash.delete(field);
        return Promise.resolve(1);
    },
};
const poll = (sets: Array<FakeSet>): Promise<Array<PrivateEvent>> => privateSets(fn => fn({ postSets: { search: () => Promise.resolve(sets) } } as never), 1, store);
const set = (id: number, postIds: Array<number>, minute: number, isPublic = false): FakeSet => ({ id, is_public: isPublic, post_ids: postIds, updated_at: `2026-11-10T12:${String(minute).padStart(2, "0")}:00.000-06:00` });

describe("private sets", () => {
    test("the first look only stores them", async () => {
        expect(await poll([set(1, [10, 11], 0)])).toEqual([]);
    });

    test("added and removed posts go out as their own events", async () => {
        const events = await poll([set(1, [11, 12, 13], 1)]);
        expect(events.map(e => [e.type, (e.data as { post_ids: Array<number> }).post_ids])).toEqual([["private_post_set.add_posts", [12, 13]], ["private_post_set.remove_posts", [10]]]);
        expect(events[0]!.id).toBe(`private_post_set.add_posts:1:${Date.parse("2026-11-10T12:01:00.000-06:00")}`);
    });

    test("nothing goes out when a set hasn't changed", async () => {
        expect(await poll([set(1, [11, 12, 13], 1)])).toEqual([]);
    });

    test("public sets are left out", async () => {
        expect(await poll([set(1, [11, 12, 13], 1), set(2, [5], 0, true)])).toEqual([]);
        expect(await poll([set(1, [11, 12, 13], 1), set(2, [5, 6], 2, true)])).toEqual([]);
    });

    test("a set that comes back after going public starts over quietly", async () => {
        await poll([]);
        expect(await poll([set(1, [11], 3)])).toEqual([]);
    });
});
