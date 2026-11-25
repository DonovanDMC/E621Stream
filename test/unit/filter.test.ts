import { describe, expect, test } from "bun:test";

import { EVENT_TYPES, PRIVATE_EVENT_TYPES } from "../../src/gateway/events.ts";
import { compileSubscription, filterMatches, FilterError, filtersFor, type Filter } from "../../src/gateway/filter.ts";

const post = { id: 100, rating: "s", uploader_id: 1, tags: { general: ["solo", "smile"], species: ["fox"], artist: ["someone"] } } as never;
const tagged = (tags: string): boolean => filterMatches("post.create", post, { tags });

describe("subscription types", () => {
    test("exact, wildcard and all", () => {
        expect(compileSubscription("post.create").types).toEqual(["post.create"]);
        expect(compileSubscription("post.*").types).toContain("post.update");
        expect(compileSubscription("post.*").types).not.toContain("post_set.create");
        expect(compileSubscription("*").types).toEqual(EVENT_TYPES);
    });

    test("private events have to be named", () => {
        expect(compileSubscription("*").privateTypes).toEqual([]);
        expect(compileSubscription("dmail.create")).toMatchObject({ types: [], privateTypes: ["dmail.create"] });
        expect(compileSubscription("private_post_set.*").privateTypes).toEqual(PRIVATE_EVENT_TYPES.filter(type => type.startsWith("private_post_set.")));
    });

    test("private events can't be filtered", () => {
        expect(() => compileSubscription({ type: "dmail.create", filter: { ids: [1] } })).toThrow(FilterError);
    });

    test("bad subscriptions are rejected", () => {
        expect(() => compileSubscription("post.nope")).toThrow(FilterError);
        expect(() => compileSubscription("nope.*")).toThrow(FilterError);
        expect(() => compileSubscription(5)).toThrow(FilterError);
        expect(() => compileSubscription({ type: "post.create", filter: [] })).toThrow(FilterError);
        expect(() => compileSubscription({ type: "post.create", filter: { tags: ["fox"] } })).toThrow(FilterError);
        expect(() => compileSubscription({ type: "post.create", filter: { ids: ["1"] } })).toThrow(FilterError);
        expect(() => compileSubscription({ type: "post.create", filter: { actions: [1] } })).toThrow(FilterError);
    });
});

describe("tags", () => {
    test("all, none and any", () => {
        expect(tagged("fox solo")).toBe(true);
        expect(tagged("fox wolf")).toBe(false);
        expect(tagged("fox -solo")).toBe(false);
        expect(tagged("-wolf")).toBe(true);
        expect(tagged("~wolf ~fox")).toBe(true);
        expect(tagged("~wolf ~cat")).toBe(false);
    });

    test("are case insensitive", () => {
        expect(tagged("FOX")).toBe(true);
    });

    test("ratings", () => {
        expect(tagged("rating:s")).toBe(true);
        expect(tagged("rating:safe")).toBe(true);
        expect(tagged("rating:e")).toBe(false);
        expect(tagged("-rating:s")).toBe(false);
        expect(tagged("-rating:explicit")).toBe(true);
    });

    test("bad queries throw", () => {
        expect(() => tagged("rating:nope")).toThrow(FilterError);
        expect(() => tagged("fox -")).toThrow(FilterError);
        expect(() => tagged(Array.from({ length: 100 }, (_, i) => `tag${i}`).join(" "))).toThrow(FilterError);
    });

    test("a post without tags doesn't match a tag filter", () => {
        expect(filterMatches("post.create", { id: 1 } as never, { tags: "fox" })).toBe(false);
    });
});

describe("matching", () => {
    test("no filter matches everything", () => {
        expect(filterMatches("post.create", post)).toBe(true);
        expect(filterMatches("post.create", post, {})).toBe(true);
    });

    test("ids", () => {
        expect(filterMatches("post.create", post, { ids: [100] })).toBe(true);
        expect(filterMatches("post.create", post, { ids: [101] })).toBe(false);
        expect(filterMatches("post.create", post, { creator_ids: [1] })).toBe(true);
        expect(filterMatches("post.create", post, { creator_ids: [2] })).toBe(false);
    });

    test("filters a type doesn't take never match", () => {
        expect(filterMatches("post.create", post, { pool_ids: [1] })).toBe(false);
    });

    test("updater_ids comes from the context", () => {
        expect(filterMatches("post.update", post, { updater_ids: [5] }, { updater_id: 5 })).toBe(true);
        expect(filterMatches("post.update", post, { updater_ids: [5] }, { updater_id: 6 })).toBe(false);
        expect(filterMatches("post.update", post, { updater_ids: [5] })).toBe(false);
    });

    test("lists match if any of them do", () => {
        const pool = { id: 3 } as never, filter: Filter = { post_ids: [1, 2] };
        expect(filterMatches("pool.add_posts", pool, filter, { post_ids: [2, 9] })).toBe(true);
        expect(filterMatches("pool.add_posts", pool, filter, { post_ids: [9] })).toBe(false);
        expect(filterMatches("pool.add_posts", pool, filter)).toBe(false);
    });
});

describe("filtersFor", () => {
    test("lists what each type takes", () => {
        expect(filtersFor("post.create")).toEqual(["ids", "post_ids", "creator_ids", "tags"]);
        expect(filtersFor("pool.add_posts")).toEqual(["ids", "pool_ids", "post_ids", "updater_ids"]);
    });

    test("every type takes ids", () => {
        // forum categories are never sent, e621 has no way to list them
        expect(EVENT_TYPES.filter(type => !type.startsWith("forum_category.") && !filtersFor(type).includes("ids"))).toEqual([]);
    });
});
