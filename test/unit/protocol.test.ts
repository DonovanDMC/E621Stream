import { describe, expect, test } from "bun:test";

import GatewayConfig from "../../src/config/GatewayConfig.ts";
import { compareIDs, DecodeError, parseCursor, parseSnapshotRequest } from "../../src/gateway/protocol.ts";

describe("parseCursor", () => {
    test("stream ids and timestamps", () => {
        expect(parseCursor("1700000000000-3")).toBe("1700000000000-3");
        expect(parseCursor("1700000000000")).toBe("1700000000000-0");
        expect(parseCursor(1_700_000_000_000)).toBe("1700000000000-0");
    });

    test("anything else", () => {
        for (const value of ["", "abc", "1-2-3", "-1", -1, 1.5, null, {}]) expect(parseCursor(value)).toBeNull();
    });
});

test("compareIDs orders by time then sequence", () => {
    expect(["2-0", "1-5", "1-10", "10-0"].sort(compareIDs)).toEqual(["1-5", "1-10", "2-0", "10-0"]);
    expect(compareIDs("5-1", "5-1")).toBe(0);
});

describe("parseSnapshotRequest", () => {
    test("a good one", () => {
        expect(parseSnapshotRequest({ resource: "post", ids: [1, 2], nonce: "a" })).toEqual({ resource: "post", ids: [1, 2], nonce: "a" });
        expect(parseSnapshotRequest({ resource: "tag", ids: [1] }).nonce).toBeNull();
    });

    test("bad ones", () => {
        const bad = [
            null,
            { ids: [1] },
            { resource: "nope", ids: [1] },
            { resource: "post" },
            { resource: "post", ids: [] },
            { resource: "post", ids: [0] },
            { resource: "post", ids: ["1"] },
            { resource: "post", ids: [1], nonce: 5 },
            { resource: "post", ids: [1], nonce: "x".repeat(1000) },
            { resource: "post", ids: Array.from({ length: GatewayConfig.maxSnapshotIDs + 1 }, (_, i) => i + 1) },
        ];
        for (const value of bad) expect(() => parseSnapshotRequest(value)).toThrow(DecodeError);
    });
});
