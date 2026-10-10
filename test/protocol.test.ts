import { describe, expect, test } from "bun:test";

import { parseBasicAuth } from "../src/gateway/auth.ts";
import { compareIds, parseCursor } from "../src/gateway/protocol.ts";
import { diff } from "../src/ingester/posts.ts";

describe("cursors", () => {
    test("accepts stream ids and millisecond timestamps", () => {
        expect(parseCursor("1700000000000-3")).toBe("1700000000000-3");
        expect(parseCursor("1700000000000")).toBe("1700000000000-0");
        expect(parseCursor(1_700_000_000_000)).toBe("1700000000000-0");
        expect(parseCursor("nope")).toBeNull();
        expect(parseCursor(-1)).toBeNull();
    });

    test("orders by time then sequence", () => {
        expect(compareIds("2-0", "1-5")).toBeGreaterThan(0);
        expect(compareIds("1-1", "1-2")).toBeLessThan(0);
        expect(compareIds("1-1", "1-1")).toBe(0);
    });
});

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
