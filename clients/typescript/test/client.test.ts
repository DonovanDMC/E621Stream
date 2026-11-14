import { describe, expect, test } from "bun:test";

import { CloseCodes, E621Stream, type StreamEvent } from "../lib/index.ts";

class FakeSocket extends EventTarget {
    static sockets: Array<FakeSocket> = [];
    readyState = 0;
    sent: Array<{ d?: Record<string, unknown>; op: string }> = [];

    constructor(readonly url: string) {
        super();
        FakeSocket.sockets.push(this);
        queueMicrotask(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
            this.receive({ op: "hello", d: { version: 1 } });
        });
    }

    close(code = 1000, reason = ""): void {
        this.readyState = 3;
        this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
    }

    receive(payload: object): void {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
    }

    send(data: string): void {
        this.sent.push(JSON.parse(data) as { d?: Record<string, unknown>; op: string });
    }
}

const infoURLs: Array<string> = [];
const fakeFetch = (async (url: URL) => {
    infoURLs.push(url.href);
    return Response.json({ websocket: "wss://somewhere.test/ws" });
}) as unknown as typeof fetch;

const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
function stream(options: Partial<ConstructorParameters<typeof E621Stream>[0]> = {}): E621Stream {
    FakeSocket.sockets = [];
    infoURLs.length = 0;
    return new E621Stream({ auth: { username: "someone", apiKey: "key" }, subscriptions: ["post.create"], WebSocket: FakeSocket as unknown as typeof WebSocket, fetch: fakeFetch, ...options });
}
const dispatch = (id: string, type = "post.create", extra = {}): object => ({ op: "dispatch", id, type, time: "2026-11-09T00:00:00Z", data: { post: { id: 1 } }, ...extra });

describe("E621Stream", () => {
    test("identifies with its credentials and subscriptions", async () => {
        stream({ client: "tests" }).connect();
        await tick();
        expect(FakeSocket.sockets[0]!.sent[0]).toEqual({ op: "identify", d: { auth: { username: "someone", api_key: "key" }, client: "tests", subscriptions: ["post.create"] } });
    });

    test("gets the websocket url from /info", async () => {
        stream({ url: "https://e621.stream" }).connect();
        await tick();
        expect(infoURLs).toEqual(["https://e621.stream/info"]);
        expect(FakeSocket.sockets[0]!.url).toBe("wss://somewhere.test/ws");
    });

    test("connects to a websocket url directly", async () => {
        stream({ url: "ws://127.0.0.1:3000/ws" }).connect();
        await tick();
        expect(infoURLs).toEqual([]);
        expect(FakeSocket.sockets[0]!.url).toBe("ws://127.0.0.1:3000/ws");
    });

    test("retries when /info fails", async () => {
        const client = stream({ fetch: (async () => new Response(null, { status: 502 })) as unknown as typeof fetch });
        const errors: Array<string> = [], reconnecting: Array<number> = [];
        client.on("error", err => errors.push(err.message)).on("reconnecting", ({ attempt }) => reconnecting.push(attempt)).connect();
        await tick();
        expect(errors).toEqual(["https://e621.stream/info returned 502"]);
        expect(reconnecting).toEqual([1]);
        expect(FakeSocket.sockets).toHaveLength(0);
        client.close();
    });

    test("sends events to dispatch and their type's listeners", async () => {
        const client = stream().connect();
        const all: Array<string> = [], posts: Array<StreamEvent<"post.create">> = [];
        client.on("dispatch", event => all.push(event.id)).on("post.create", event => posts.push(event));
        await tick();
        FakeSocket.sockets[0]!.receive(dispatch("1-0"));
        FakeSocket.sockets[0]!.receive(dispatch("2-0", "comment.create"));
        expect(all).toEqual(["1-0", "2-0"]);
        expect(posts.map(event => event.data.post.id)).toEqual([1]);
        expect(client.cursor).toBe("2-0");
    });

    test("private events don't move the cursor", async () => {
        const client = stream().connect();
        await tick();
        FakeSocket.sockets[0]!.receive(dispatch("1-0"));
        FakeSocket.sockets[0]!.receive(dispatch("dmail.create:5", "dmail.create", { private: true }));
        expect(client.cursor).toBe("1-0");
    });

    test("recoveries are passed on and their events are flagged", async () => {
        const client = stream().connect();
        const recoveries: Array<boolean> = [], recovered: Array<boolean> = [];
        client.on("recovery", recovery => recoveries.push(recovery.done)).on("dispatch", event => recovered.push(event.recovered === true));
        await tick();
        const d = { id: "r1", from: "2026-11-14T02:00:00Z", to: "2026-11-14T08:00:00Z", sources: ["posts"] };
        FakeSocket.sockets[0]!.receive({ op: "recovery", id: "1-0", d: { ...d, done: false } });
        FakeSocket.sockets[0]!.receive(dispatch("2-0", "post.create", { recovered: true }));
        FakeSocket.sockets[0]!.receive(dispatch("3-0"));
        FakeSocket.sockets[0]!.receive({ op: "recovery", id: "4-0", d: { ...d, done: true, status: "done", events: 1 } });
        expect(recoveries).toEqual([false, true]);
        expect(recovered).toEqual([true, false]);
        expect(client.cursor).toBe("4-0");
        client.close();
    });

    test("reconnects and resumes from the last event", async () => {
        const client = stream().connect();
        const reconnecting: Array<number> = [];
        client.on("reconnecting", ({ attempt }) => reconnecting.push(attempt));
        await tick();
        FakeSocket.sockets[0]!.receive(dispatch("7-0"));
        FakeSocket.sockets[0]!.close(1006);
        expect(reconnecting).toEqual([1]);
        await tick(1300);
        expect(FakeSocket.sockets).toHaveLength(2);
        expect(FakeSocket.sockets[1]!.sent[0]!.d!.cursor).toBe("7-0");
        client.close();
    });

    test("doesn't reconnect after a close retrying won't fix", async () => {
        const client = stream().connect();
        const errors: Array<number> = [], closes: Array<boolean> = [];
        client.on("error", err => errors.push((err as unknown as { code: number }).code)).on("close", ({ reconnecting }) => closes.push(reconnecting));
        await tick();
        FakeSocket.sockets[0]!.receive({ op: "error", d: { code: CloseCodes.AUTHENTICATION_FAILED, message: "invalid credentials" } });
        FakeSocket.sockets[0]!.close(CloseCodes.AUTHENTICATION_FAILED);
        expect(errors).toEqual([CloseCodes.AUTHENTICATION_FAILED]);
        expect(closes).toEqual([false]);
    });

    test("snapshots are matched to their reply", async () => {
        const client = stream().connect();
        await tick();
        const socket = FakeSocket.sockets[0]!;
        expect(await client.snapshots("post", [1]).catch((err: unknown) => String(err))).toBe("Error: not ready");
        socket.receive({ op: "ready", d: {} });
        const posts = client.snapshots("post", [1, 2]), comments = client.snapshots("comment", [3]);
        expect(socket.sent.slice(-2)).toEqual([{ op: "snapshot", d: { resource: "post", ids: [1, 2], nonce: "1" } }, { op: "snapshot", d: { resource: "comment", ids: [3], nonce: "2" } }]);
        socket.receive({ op: "snapshot", d: { resource: "comment", nonce: "2", snapshots: { 3: { id: 3, body: "hi" } } } });
        let settled = false;
        void posts.then(() => settled = true);
        socket.receive({ op: "snapshot", d: { resource: "post", nonce: "1", snapshots: { 1: { id: 1, rating: "s" } }, done: false } });
        await tick();
        expect(settled).toBe(false);
        socket.receive({ op: "snapshot", d: { resource: "post", nonce: "1", snapshots: { 2: null }, done: true } });
        expect(await posts).toEqual({ 1: { id: 1, rating: "s" }, 2: null });
        expect((await comments)[3]?.body).toBe("hi");
        client.close();
    });

    test("snapshots waiting on a reply fail when the connection closes", async () => {
        const client = stream().connect();
        await tick();
        FakeSocket.sockets[0]!.receive({ op: "ready", d: {} });
        const posts = client.snapshots("post", [1]);
        FakeSocket.sockets[0]!.receive({ op: "error", d: { code: CloseCodes.DECODE_ERROR, message: "too many ids (max 100)" } });
        FakeSocket.sockets[0]!.close(CloseCodes.DECODE_ERROR);
        expect(await posts.catch((err: unknown) => String(err))).toBe("StreamError: too many ids (max 100)");
    });

    test("subscribe sends the change and keeps it for reconnecting", async () => {
        const client = stream().connect();
        await tick();
        client.subscribe(["comment.*"]);
        expect(FakeSocket.sockets[0]!.sent.at(-1)).toEqual({ op: "subscribe", d: { subscriptions: ["comment.*"] } });
        expect(client.options.subscriptions).toEqual(["comment.*"]);
        client.close();
    });
});
