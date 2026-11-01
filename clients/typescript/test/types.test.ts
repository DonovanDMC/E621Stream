// only has to compile
import { expect, test } from "bun:test";

import { E621Stream, type Comment, type LegacyPost, type StreamEvent } from "../lib/index.ts";

const stream = new E621Stream({ subscriptions: ["*"] });

test("event types narrow", () => {
    stream.on("post.create", (event) => {
        const post: LegacyPost = event.data.post;
        void post;
    });
    stream.on("post.update", (event) => {
        const added: Array<string> | undefined = event.data.changes?.["tags.general"]?.added;
        const rating: "e" | "q" | "s" | undefined = event.data.changes?.rating?.new;
        void added;
        void rating;
    });
    stream.on("comment.update", (event) => {
        const comment: Comment = event.data.comment;
        const body: string | undefined = event.data.changes?.body?.new;
        void comment;
        void body;
    });
    stream.on("user.update", (event) => {
        if (event.data.action === "user_level_change") {
            const level: string = event.data.values.level;
            void level;
        }
    });
    stream.on("pool.add_posts", (event) => {
        const ids: Array<number> = event.data.post_ids;
        void ids;
    });
    stream.on("dispatch", (event: StreamEvent) => {
        if (event.type === "post_set.add_posts") {
            const name: string = event.data.post_set.name;
            void name;
        }
    });
    stream.on("dmail.create", (event) => {
        const title: string = event.data.title;
        void title;
    });
    stream.on("comment.create", (event) => {
        // @ts-expect-error comments don't have a post
        void event.data.post;
    });
    expect(true).toBe(true);
});
