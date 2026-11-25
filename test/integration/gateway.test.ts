import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import DB from "../../src/db/DB.ts";
import { publish } from "../../src/gateway/events.ts";
import { CloseCodes } from "../../src/gateway/protocol.ts";
import { saveSnapshots } from "../../src/gateway/snapshots.ts";
import { closeSockets, reset, startService, stopService, TestSocket, tokenUser } from "../helpers.ts";

const PORT = 4201, BASE = `ws://127.0.0.1:${PORT}/ws`, URL = `${BASE}?v=2`;

let gateway: Bun.Subprocess | undefined;
beforeAll(async () => {
    await reset();
    // recheck quickly, so a revoked token can be seen being disconnected
    gateway = await startService("src/gateway/index.ts", `http://127.0.0.1:${PORT}`, { GATEWAY_PORT: String(PORT), SESSION_RECHECK_INTERVAL: "300" });
});

afterAll(async () => stopService(gateway));
afterEach(closeSockets);

let token: string;
beforeEach(async () => {
    await reset();
    ({ token } = await tokenUser());
});

const post = (id: number): never => ({ id, change_seq: id, rating: "s", tags: { general: ["fox"] } }) as never;

describe("connecting", () => {
    test("hello says what it needs", async () => {
        const socket = new TestSocket(URL);
        expect((await socket.next("hello")).d).toMatchObject({ version: 2, auth_required: true, private_events: ["dmail.create", "private_post_set.add_posts", "private_post_set.remove_posts"] });
    });

    test("hello has the version asked for", async () => {
        const socket = new TestSocket(URL);
        expect(await socket.next("hello")).toMatchObject({ d: { version: 2 } });
    });

    test("leaving the version out is closed before hello", async () => {
        for (const url of [BASE, `${BASE}?v=`, `${BASE}?version=2`]) {
            const socket = new TestSocket(url);
            expect(await socket.next("error")).toMatchObject({ d: { code: CloseCodes.UnsupportedVersion, message: "a protocol version is required, connect with ?v=2" } });
            expect((await socket.closedWith()).code).toBe(CloseCodes.UnsupportedVersion);
        }
    });

    test("an unsupported version is closed before hello", async () => {
        for (const v of ["1", "3", "nope"]) {
            const socket = new TestSocket(`${BASE}?v=${v}`);
            expect(await socket.next("error")).toMatchObject({ d: { code: CloseCodes.UnsupportedVersion } });
            expect((await socket.closedWith()).code).toBe(CloseCodes.UnsupportedVersion);
            expect(socket.messages.map(message => message.op)).toEqual(["error"]);
        }
    });

    test("identifying without auth fails", async () => {
        const socket = new TestSocket(URL);
        await socket.next("hello");
        socket.send("identify", { subscriptions: ["*"] });
        expect((await socket.closedWith()).code).toBe(CloseCodes.AuthenticationFailed);
    });

    test("a bad token fails", async () => {
        const socket = new TestSocket(URL);
        await socket.next("hello");
        socket.send("identify", { auth: { token: `${token}x` }, subscriptions: ["*"] });
        expect((await socket.closedWith()).code).toBe(CloseCodes.AuthenticationFailed);
    });

    test("a token gets ready", async () => {
        const socket = new TestSocket(URL);
        const ready = await socket.identify({ auth: { token }, subscriptions: ["post.*", "tag.update"] });
        expect(ready.d).toMatchObject({ user: { id: 1, name: "user_1" }, subscriptions: 2, replaying: false, recovery: null, slow_mode: null });
    });

    test("bad subscriptions close the connection", async () => {
        const socket = new TestSocket(URL);
        await socket.next("hello");
        socket.send("identify", { auth: { token }, subscriptions: ["post.nope"] });
        expect((await socket.closedWith()).code).toBe(CloseCodes.InvalidSubscription);
    });

    test("private events need them turned on for the token", async () => {
        const socket = new TestSocket(URL);
        await socket.next("hello");
        socket.send("identify", { auth: { token }, subscriptions: ["dmail.create"] });
        expect((await socket.closedWith()).code).toBe(CloseCodes.InvalidSubscription);
    });

    test("unknown ops close the connection", async () => {
        const socket = new TestSocket(URL);
        await socket.identify({ auth: { token }, subscriptions: ["*"] });
        socket.send("nope");
        expect((await socket.closedWith()).code).toBe(CloseCodes.UnknownOP);
    });

    test("a revoked token is disconnected", async () => {
        const socket = new TestSocket(URL);
        await socket.identify({ auth: { token }, subscriptions: ["*"] });
        await DB`DELETE FROM gateway_tokens`;
        expect((await socket.closedWith()).code).toBe(CloseCodes.AuthenticationExpired);
    });
});

describe("events", () => {
    test("are sent to who's subscribed, with their context", async () => {
        const posts = new TestSocket(URL), tags = new TestSocket(URL);
        await posts.identify({ auth: { token }, subscriptions: ["post.*"] });
        await tags.identify({ auth: { token }, subscriptions: ["tag.update"] });
        const id = await publish("post.update", "2026-11-01T00:00:00Z", post(1), { updater_id: 5 });
        const dispatch = await posts.next("dispatch");
        expect(dispatch).toMatchObject({ s: id, t: "2026-11-01T00:00:00Z", d: { type: "post.update", recovered: false, private: false, data: { id: 1 }, context: { updater_id: 5 } } });
        expect(await tags.nothing("dispatch")).toBe(true);
    });

    test("filters", async () => {
        const socket = new TestSocket(URL);
        await socket.identify({ auth: { token }, subscriptions: [{ type: "post.update", filter: { updater_ids: [5] } }] });
        await publish("post.update", "2026-11-01T00:00:00Z", post(1), { updater_id: 6 });
        await publish("post.update", "2026-11-01T00:00:00Z", post(2), { updater_id: 5 });
        expect(await socket.next("dispatch")).toMatchObject({ d: { data: { id: 2 } } });
        expect(await socket.nothing("dispatch")).toBe(true);
    });

    test("subscriptions can be changed", async () => {
        const socket = new TestSocket(URL);
        await socket.identify({ auth: { token }, subscriptions: ["tag.update"] });
        socket.send("subscribe", { subscriptions: ["post.update", "post.create"] });
        expect(await socket.next("subscribed")).toMatchObject({ d: { subscriptions: 2 } });
        await publish("post.update", "2026-11-01T00:00:00Z", post(1));
        expect(await socket.next("dispatch")).toMatchObject({ d: { type: "post.update" } });
    });

    test("replaying from a cursor sends what came after it", async () => {
        const first = await publish("post.update", "2026-11-01T00:00:00Z", post(1));
        await publish("tag.update", "2026-11-01T00:00:00Z", { id: 1 } as never);
        const third = await publish("post.update", "2026-11-01T00:00:00Z", post(3));
        const socket = new TestSocket(URL);
        const ready = await socket.identify({ auth: { token }, subscriptions: ["post.*"], cursor: first });
        expect(ready.d).toMatchObject({ replaying: true, cursor_expired: false });
        expect((await socket.next("dispatch")).s).toBe(third);
        await socket.next("replay_complete");
        // then live
        const live = await publish("post.update", "2026-11-01T00:00:00Z", post(4));
        expect((await socket.next("dispatch")).s).toBe(live);
    });

    test("bad cursors close the connection", async () => {
        const socket = new TestSocket(URL);
        await socket.next("hello");
        socket.send("identify", { auth: { token }, subscriptions: ["*"], cursor: "nope" });
        expect((await socket.closedWith()).code).toBe(CloseCodes.InvalidCursor);
    });
});

describe("other messages", () => {
    test("heartbeats are acked", async () => {
        const socket = new TestSocket(URL);
        await socket.identify({ auth: { token }, subscriptions: ["*"] });
        socket.send("heartbeat");
        expect((await socket.next("heartbeat_ack")).d).toHaveProperty("cursor");
    });

    test("snapshots", async () => {
        await saveSnapshots("post", [post(1)]);
        const socket = new TestSocket(URL);
        await socket.identify({ auth: { token }, subscriptions: ["*"] });
        socket.send("snapshot", { resource: "post", ids: [1, 2], nonce: "n" });
        const reply = await socket.next("snapshot");
        expect(reply.d).toMatchObject({ resource: "post", nonce: "n", snapshots: { 1: { resource: "post", id: 1, version: 1, data: { id: 1, rating: "s" } }, 2: null } });
    });

    test("a bad snapshot request closes the connection", async () => {
        const socket = new TestSocket(URL);
        await socket.identify({ auth: { token }, subscriptions: ["*"] });
        socket.send("snapshot", { resource: "nope", ids: [1] });
        expect(await socket.next("error")).toMatchObject({ d: { code: CloseCodes.DecodeError } });
        expect((await socket.closedWith()).code).toBe(CloseCodes.DecodeError);
    });
});
