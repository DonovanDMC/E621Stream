import { expect, test } from "bun:test";

import { parseBasicAuth } from "../src/gateway/auth.ts";
import { diff } from "../src/ingester/posts.ts";

test("basic auth header", () => {
    expect(parseBasicAuth(`Basic ${btoa("someone:abc:def")}`)).toEqual({ username: "someone", apiKey: "abc:def" });
    expect(parseBasicAuth("Bearer abc")).toBeNull();
    expect(parseBasicAuth(null)).toBeNull();
});

test("post diffs", () => {
    const before = {
        approver_id: null,
        change_seq: 1,
        children: [],
        description: "",
        flags: { deleted: false },
        has_notes: false,
        locked_tags: [],
        md5: "a",
        parent_id: null,
        pools: [],
        rating: "s",
        sources: ["https://example.com"],
        tags: { general: ["solo"], artist: [] },
    };
    const after = { ...before, change_seq: 2, rating: "q", flags: { deleted: true }, tags: { general: ["solo", "smile"], artist: ["someone"] } };
    expect(diff(before, after)).toEqual({
        "tags.general": { added: ["smile"], removed: [] },
        "tags.artist": { added: ["someone"], removed: [] },
        "rating": { old: "s", new: "q" },
        "flags.deleted": { old: false, new: true },
    });
    expect(diff(before, before)).toEqual({});
});
