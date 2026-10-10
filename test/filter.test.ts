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

describe("tag filters", () => {
    const sub = (tags: string): ReturnType<typeof compile> => compile({ type: "post.*", filter: { tags } });

    test("required, excluded and optional tags", () => {
        expect(matches(sub("fox solo"), created)).toBe(true);
        expect(matches(sub("fox -solo"), created)).toBe(false);
        expect(matches(sub("~wolf ~fox"), created)).toBe(true);
        expect(matches(sub("~wolf ~cat"), created)).toBe(false);
    });

    test("ratings", () => {
        expect(matches(sub("rating:s"), created)).toBe(true);
        expect(matches(sub("rating:safe"), created)).toBe(true);
        expect(matches(sub("rating:e"), created)).toBe(false);
        expect(matches(sub("-rating:s"), created)).toBe(false);
        expect(() => sub("rating:x")).toThrow(FilterError);
    });

    test("post versions use their tag string", () => {
        const version = event("post_version.create", { post_id: 100, tags: "fox solo", rating: "e", updater_id: 3 });
        expect(matches(compile({ type: "post_version.create", filter: { tags: "fox rating:e" } }), version)).toBe(true);
    });

    test("events without tags never match a tag filter", () => {
        const comment = event("comment.create", { post_id: 100, creator_id: 3 });
        expect(matches(compile({ type: "*", filter: { tags: "fox" } }), comment)).toBe(false);
    });
});

describe("id filters", () => {
    test("post, pool and user ids", () => {
        expect(matches(compile({ type: "*", filter: { post_ids: [100] } }), created)).toBe(true);
        expect(matches(compile({ type: "*", filter: { post_ids: [101] } }), created)).toBe(false);
        expect(matches(compile({ type: "*", filter: { pool_ids: [5] } }), created)).toBe(true);
        expect(matches(compile({ type: "*", filter: { user_ids: [2] } }), created)).toBe(true);
        expect(matches(compile({ type: "*", filter: { user_ids: [9] } }), created)).toBe(false);
    });

    test("actions", () => {
        const deleted = event("post_event.create", { post_id: 100, action: "deleted", creator_id: 4 });
        expect(matches(compile({ type: "post_event.create", filter: { actions: ["deleted", "undeleted"] } }), deleted)).toBe(true);
        expect(matches(compile({ type: "post_event.create", filter: { actions: ["approved"] } }), deleted)).toBe(false);
    });

    test("updates filter by the wrapped record", () => {
        const edited = event("comment.update", { comment: { id: 7, post_id: 100, creator_id: 3, updater_id: 4 }, changes: { body: { old: "a", new: "b" } } });
        expect(matches(compile({ type: "comment.*", filter: { post_ids: [100] } }), edited)).toBe(true);
        expect(matches(compile({ type: "comment.update", filter: { user_ids: [4] } }), edited)).toBe(true);
        expect(matches(compile({ type: "comment.update", filter: { post_ids: [1] } }), edited)).toBe(false);

        const alias = event("tag_alias.update", { tag_alias: { id: 1, forum_topic_id: 50, creator_id: 3 }, changes: null });
        expect(matches(compile({ type: "tag_alias.update", filter: { topic_ids: [50] } }), alias)).toBe(true);
    });

    test("mod action events filter by the action's values", () => {
        const hidden = event("forum_post.hide", { id: 1, action: "forum_post_hide", creator_id: 5, values: { forum_post_id: 9, forum_topic_id: 50, user_id: 3 } });
        expect(matches(compile({ type: "forum_post.*", filter: { topic_ids: [50] } }), hidden)).toBe(true);
        expect(matches(compile({ type: "forum_post.hide", filter: { user_ids: [3] } }), hidden)).toBe(true);
        expect(matches(compile({ type: "forum_post.hide", filter: { topic_ids: [51] } }), hidden)).toBe(false);
        expect(matches(compile("tag.delete"), event("tag.delete", { action: "tag_destroy", values: { name: "x" } }))).toBe(true);
    });

    test("records about a user match that user", () => {
        const pool = event("pool.create", { id: 5, creator_id: 3, post_ids: [100] });
        expect(matches(compile({ type: "pool.create", filter: { pool_ids: [5] } }), pool)).toBe(true);
        expect(matches(compile({ type: "pool.create", filter: { user_ids: [3] } }), pool)).toBe(true);
        expect(matches(compile({ type: "user.create", filter: { user_ids: [8] } }), event("user.create", { id: 8, name: "new" }))).toBe(true);

        const ban = event("ban.create", { id: 1, user_id: 8, banner_id: 2 });
        expect(matches(compile({ type: "ban.create", filter: { user_ids: [8] } }), ban)).toBe(true);
        expect(matches(compile({ type: "ban.create", filter: { user_ids: [2] } }), ban)).toBe(true);
        const approval = event("post_approval.create", { id: 1, user_id: 2, post_id: 100 });
        expect(matches(compile({ type: "post_approval.create", filter: { post_ids: [100], user_ids: [2] } }), approval)).toBe(true);
    });

    test("updates from versions filter by the version", () => {
        const note = event("note.update", { id: 1, note_id: 2, post_id: 100, updater_id: 3, version: 4 });
        expect(matches(compile({ type: "note.update", filter: { post_ids: [100] } }), note)).toBe(true);
        expect(matches(compile({ type: "note.*", filter: { user_ids: [3] } }), note)).toBe(true);
        expect(matches(compile({ type: "pool.update", filter: { pool_ids: [5] } }), event("pool.update", { id: 1, pool_id: 5, updater_id: 3 }))).toBe(true);
    });

    test("mod action updates and deletes filter by the action's values", () => {
        const pool = event("pool.delete", { id: 1, action: "pool_delete", creator_id: 2, values: { pool_id: 5, pool_name: "x", user_id: 3 } });
        expect(matches(compile({ type: "pool.*", filter: { pool_ids: [5] } }), pool)).toBe(true);
        const feedback = event("user_feedback.update", { id: 1, action: "user_feedback_update", creator_id: 2, values: { user_id: 8, reason: "b", reason_was: "a" } });
        expect(matches(compile({ type: "user_feedback.update", filter: { user_ids: [8] } }), feedback)).toBe(true);
        expect(matches(compile({ type: "user_feedback.update", filter: { user_ids: [9] } }), feedback)).toBe(false);
    });

    test("membership events match any of their posts", () => {
        const pool = event("pool.add_posts", { pool_version: { id: 1, pool_id: 5, updater_id: 3 }, post_ids: [100, 101] });
        expect(matches(compile({ type: "pool.add_posts", filter: { post_ids: [101] } }), pool)).toBe(true);
        expect(matches(compile({ type: "pool.*", filter: { pool_ids: [5], user_ids: [3] } }), pool)).toBe(true);
        expect(matches(compile({ type: "pool.add_posts", filter: { post_ids: [102] } }), pool)).toBe(false);

        const set = event("post_set.remove_posts", { post_set: { id: 9, creator_id: 3 }, post_ids: [100] });
        expect(matches(compile({ type: "post_set.*", filter: { set_ids: [9], post_ids: [100] } }), set)).toBe(true);
        expect(matches(compile({ type: "post_set.*", filter: { set_ids: [8] } }), set)).toBe(false);
        expect(matches(compile({ type: "post_set.update", filter: { set_ids: [9] } }), event("post_set.update", { post_set: { id: 9 }, changes: {} }))).toBe(true);
    });

    test("bad ids are rejected", () => {
        expect(() => compile({ type: "*", filter: { post_ids: ["1"] } })).toThrow(FilterError);
    });
});
