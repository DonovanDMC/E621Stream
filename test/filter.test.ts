import { describe, expect, test } from "bun:test";

import { compile, FilterError, matches } from "../src/gateway/filter.ts";

import type { StreamEvent } from "../src/events.ts";

function event(type: StreamEvent["type"], data: Record<string, unknown>): StreamEvent {
    return { id: "1-0", type, time: "", data, raw: JSON.stringify(data) };
}

const post = {
    id: 100,
    rating: "s",
    pools: [5],
    uploader_id: 1,
    approver_id: 2,
    tags: { general: ["solo", "smile"], species: ["fox"], artist: ["someone"] },
};
const created = event("post.create", { post });

describe("subscription types", () => {
    test("exact, wildcard and all", () => {
        expect(matches(compile("post.create"), created)).toBe(true);
        expect(matches(compile("post.update"), created)).toBe(false);
        expect(matches(compile("post.*"), created)).toBe(true);
        expect(matches(compile("*"), created)).toBe(true);
    });

    test("unknown types are rejected", () => {
        expect(() => compile("post.nope")).toThrow(FilterError);
        expect(() => compile("nope.*")).toThrow(FilterError);
        expect(() => compile({})).toThrow(FilterError);
    });
});
