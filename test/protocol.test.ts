import { describe, expect, test } from "bun:test";
import { UnexpectedResponseError } from "e621";

import { parseAuthHeader, parseBasicAuth } from "../src/gateway/auth.ts";
import { isInvalidGrant, parseToken } from "../src/gateway/oauth.ts";
import { compareIds, parseCursor, parseSnapshotRequest } from "../src/gateway/protocol.ts";
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

test("snapshot requests", () => {
    expect(parseSnapshotRequest({ resource: "post", ids: [1, 2, 2], nonce: "a" }, 100)).toEqual({ resource: "post", ids: [1, 2], nonce: "a" });
    expect(parseSnapshotRequest({ resource: "comment", ids: [5] }, 100)).toEqual({ resource: "comment", ids: [5], nonce: null });
    expect(parseSnapshotRequest({ resource: "pool", ids: [1] }, 100)).toBe("unknown resource \"pool\"");
    expect(parseSnapshotRequest({ resource: "post", ids: [] }, 100)).toBe("no ids");
    expect(parseSnapshotRequest({ resource: "post", ids: [1, 2, 3] }, 2)).toBe("too many ids (max 2)");
    expect(parseSnapshotRequest({ resource: "post", ids: ["1"] }, 100)).toBe("ids must be positive integers");
    expect(parseSnapshotRequest({ resource: "post", ids: [1], nonce: 5 }, 100)).toBe("invalid nonce");
    expect(parseSnapshotRequest(undefined, 100)).toBe("missing payload");
});

test("basic auth header", () => {
    expect(parseBasicAuth(`Basic ${btoa("someone:abc:def")}`)).toEqual({ username: "someone", apiKey: "abc:def" });
    expect(parseBasicAuth("Bearer abc")).toBeNull();
    expect(parseBasicAuth(null)).toBeNull();
});

test("bearer auth header", () => {
    expect(parseAuthHeader("Bearer e6s_abc")).toEqual({ token: "e6s_abc" });
    expect(parseAuthHeader(`Basic ${btoa("someone:key")}`)).toEqual({ username: "someone", apiKey: "key" });
    // e621's own access tokens aren't ours
    expect(parseAuthHeader("Bearer abc")).toBeNull();
    expect(parseToken(123)).toBeNull();
});

test("invalid_grant means the link is gone", () => {
    const error = (status: number, body: unknown): UnexpectedResponseError => new UnexpectedResponseError(undefined, new Response(null, { status }), body);
    expect(isInvalidGrant(error(400, { error: "invalid_grant", error_description: "revoked" }))).toBe(true);
    expect(isInvalidGrant(error(400, { error: "invalid_request" }))).toBe(false);
    // our own client credentials being wrong shouldn't unlink anyone
    expect(isInvalidGrant(error(401, { error: "invalid_client" }))).toBe(false);
    expect(isInvalidGrant(new Error("invalid_grant"))).toBe(false);
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
