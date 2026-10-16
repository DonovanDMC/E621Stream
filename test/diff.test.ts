import { describe, expect, test } from "bun:test";

import { diff as postDiff, type Snapshot } from "../src/ingester/posts.ts";
import { diff } from "../src/ingester/updates.ts";

const post: Snapshot = {
    approver_id: null,
    change_seq: 2,
    children: [],
    description: "",
    flags: { deleted: false, pending: false },
    has_notes: false,
    locked_tags: [],
    md5: "abc",
    parent_id: null,
    pools: [1],
    rating: "s",
    sources: [],
    tags: { general: ["solo"], species: ["fox"] },
};

describe("diffs", () => {
    test("post fields missing from the old snapshot aren't reported", () => {
        const partial: Partial<Snapshot> = { ...post, rating: "e" };
        delete partial.has_notes;
        delete partial.pools;
        delete partial.tags;
        expect(postDiff(partial, { ...post, has_notes: true, pools: [2], tags: { general: ["duo"] } })).toEqual({ rating: { old: "e", new: "s" } });
    });

    test("post tags are reported per category", () => {
        expect(postDiff(post, { ...post, tags: { general: ["solo"], species: ["wolf"] } })).toEqual({ "tags.species": { added: ["wolf"], removed: ["fox"] } });
    });

    test("record fields missing from the old snapshot aren't reported", () => {
        expect(diff({ status: "pending" }, { status: "active", reason: "x" })).toEqual({ status: { old: "pending", new: "active" } });
    });

    test("a field that was null is still compared", () => {
        expect(diff({ approver_id: null }, { approver_id: 5 })).toEqual({ approver_id: { old: null, new: 5 } });
    });
});
