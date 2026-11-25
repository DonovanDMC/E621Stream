import { expect, test } from "bun:test";

import { E621Stream, type Comment, type ExtendedPost, type StreamEvent } from "../lib/index.ts";

const stream = new E621Stream({ subscriptions: ["*"] });

test("event types narrow", () => {
    stream.on("post.create", (event) => {
        const post: ExtendedPost = event.data;
        const general: Array<string> = event.data.tags.general;
        void post;
        void general;
    });
    stream.on("post.update", (event) => {
        const updater: number | undefined = event.context?.updater_id;
        void updater;
    });
    stream.on("comment.update", (event) => {
        const comment: Comment = event.data;
        void comment;
    });
    stream.on("user.update", (event) => {
        const name: string = event.data.name;
        const action: string | undefined = event.context?.mod_action?.action;
        const before: Record<string, unknown> | undefined = event.context?.previous;
        void name;
        void action;
        void before;
    });
    stream.on("post.destroy", (event) => {
        const id: number = event.data.id;
        void id;
    });
    stream.on("pool.add_posts", (event) => {
        const ids: Array<number> | undefined = event.context?.post_ids;
        const poolName: string = event.data.name;
        void ids;
        void poolName;
    });
    stream.on("dispatch", (event: StreamEvent) => {
        if (event.type === "post_set.add_posts") {
            const name: string = event.data.name;
            void name;
        }
    });
    stream.on("dmail.create", (event) => {
        const title: string = event.data.title;
        void title;
    });
    stream.on("comment.create", (event) => {
        // @ts-expect-error comments don't have tags
        void event.data.tags;
    });
    expect(true).toBe(true);
});
