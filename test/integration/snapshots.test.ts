import { beforeEach, describe, expect, test } from "bun:test";

import {
    getBanSnapshotByUser, getSnapshot, getSnapshots, getTagSnapshotByName, modActionUpdater, removeSnapshots, saveSnapshot, saveSnapshots, updateSnapshot, versionOf,
} from "../../src/gateway/snapshots.ts";
import { reset } from "../helpers.ts";

beforeEach(reset);

const post = (id: number, changeSeq: number, rating = "s"): never => ({ id, change_seq: changeSeq, rating, tags: { general: ["fox"] }, not_a_post_field: true }) as never;
const tag = (id: number, name: string, at: string): never => ({ id, name, category: 0, post_count: 1, updated_at: at, created_at: at }) as never;

test("versions are a post's change_seq, otherwise when it was updated", () => {
    expect(versionOf("post", post(1, 55))).toBe(55);
    expect(versionOf("tag", tag(1, "fox", "2026-11-01T00:00:00Z"))).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(versionOf("ban", { id: 1, created_at: "2026-11-01T00:00:00Z" } as never)).toBe(Date.parse("2026-11-01T00:00:00Z"));
});

test("only the record's own fields are stored", async () => {
    await saveSnapshot("post", post(1, 1));
    expect(await getSnapshot("post", 1)).toEqual({ id: 1, change_seq: 1, rating: "s", tags: { general: ["fox"] } } as never);
});

describe("saveSnapshots", () => {
    test("stores many, and leaves out ones that aren't stored when getting them", async () => {
        await saveSnapshots("post", [post(1, 1), post(2, 1)]);
        const found = await getSnapshots("post", [1, 2, 3]);
        expect([...found.keys()].sort()).toEqual([1, 2]);
        expect(found.get(1)?.version).toBe(1);
    });

    test("an older version doesn't replace a newer one", async () => {
        await saveSnapshots("post", [post(1, 5, "e")]);
        await saveSnapshots("post", [post(1, 3, "q")]);
        expect((await getSnapshot("post", 1))?.rating).toBe("e");
        await saveSnapshots("post", [post(1, 6, "q")]);
        expect((await getSnapshot("post", 1))?.rating).toBe("q");
    });

    test("the same record twice in one batch keeps the newest", async () => {
        await saveSnapshots("post", [post(1, 2, "q"), post(1, 4, "e"), post(1, 3, "s")]);
        expect((await getSnapshot("post", 1))?.rating).toBe("e");
    });

    test("resources don't share ids", async () => {
        await saveSnapshots("post", [post(1, 1)]);
        expect(await getSnapshot("tag", 1)).toBeNull();
    });
});

test("removeSnapshots", async () => {
    await saveSnapshots("post", [post(1, 1), post(2, 1)]);
    await removeSnapshots("post", [1]);
    expect([...(await getSnapshots("post", [1, 2])).keys()]).toEqual([2]);
});

describe("updateSnapshot", () => {
    test("applies changes", async () => {
        await saveSnapshot("tag", tag(1, "fox", "2026-11-01T00:00:00Z"));
        expect(await updateSnapshot("tag", 1, { category: 5, updated_at: "2026-11-02T00:00:00Z" } as never)).toMatchObject({ name: "fox", category: 5 });
        expect((await getSnapshot("tag", 1))?.category).toBe(5);
    });

    test("doesn't go back over something newer", async () => {
        await saveSnapshot("tag", tag(1, "fox", "2026-11-05T00:00:00Z"));
        await updateSnapshot("tag", 1, { category: 5, updated_at: "2026-11-02T00:00:00Z" } as never);
        expect((await getSnapshot("tag", 1))?.category).toBe(0);
    });

    test("null when it isn't stored", async () => {
        expect(await updateSnapshot("tag", 1, { category: 5 } as never)).toBeNull();
    });
});

test("lookups by name and user", async () => {
    await saveSnapshots("tag", [tag(1, "fox", "2026-11-01T00:00:00Z"), tag(2, "wolf", "2026-11-01T00:00:00Z")]);
    await saveSnapshot("ban", { id: 7, user_id: 50, banner_id: 2, reason: "x", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" } as never);
    expect((await getTagSnapshotByName("wolf"))?.id).toBe(2);
    expect(await getTagSnapshotByName("cat")).toBeNull();
    expect((await getBanSnapshotByUser(50))?.id).toBe(7);
    expect(await getBanSnapshotByUser(51)).toBeNull();
});

test("modActionUpdater finds who made a change from a recent mod action", async () => {
    const action = (id: number, at: string, creator: number): never => ({ id, action: "tag_alias_create", values: { antecedent: "fox" }, creator_id: creator, created_at: at, updated_at: at }) as never;
    await saveSnapshots("mod_action", [action(1, "2026-11-01T00:00:00Z", 10), action(2, "2026-11-01T00:05:00Z", 11)]);
    expect(await modActionUpdater(["tag_alias_create"], "antecedent", "fox", "2026-11-01T00:06:00Z")).toBe(11);
    expect(await modActionUpdater(["tag_alias_create"], "antecedent", "wolf", "2026-11-01T00:06:00Z")).toBeNull();
    // too long before the change
    expect(await modActionUpdater(["tag_alias_create"], "antecedent", "fox", "2026-11-01T01:00:00Z")).toBeNull();
});
