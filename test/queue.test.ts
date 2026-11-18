import { describe, expect, test } from "bun:test";
import { UnexpectedResponseError } from "e621";

import { RequestQueue } from "../src/e621.ts";

// postsRecovery.test.ts mocks request() and bun's module mocks carry over to other files, the query gets a separate copy
const unmocked = "../src/e621.ts?unmocked";
const { request } = await import(unmocked) as typeof import("../src/e621.ts");

describe("RequestQueue", () => {
    test("spaces request starts out", async () => {
        const queue = new RequestQueue(40);
        const starts: Array<number> = [];
        await Promise.all([1, 2, 3].map(() => queue.schedule(async () => { starts.push(performance.now()); })));
        expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35);
        expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(35);
    });

    test("doesn't wait for a slow request to finish", async () => {
        const queue = new RequestQueue(20);
        const starts: Array<number> = [];
        const slow = (): Promise<void> => {
            starts.push(performance.now());
            return Bun.sleep(200);
        };
        await Promise.all([queue.schedule(slow), queue.schedule(slow)]);
        expect(starts[1]! - starts[0]!).toBeLessThan(100);
    });

    test("never has more than two in flight", async () => {
        const queue = new RequestQueue(1);
        let inFlight = 0, most = 0;
        const slow = async (): Promise<void> => {
            inFlight++;
            most = Math.max(most, inFlight);
            await Bun.sleep(30);
            inFlight--;
        };
        await Promise.all(Array.from({ length: 6 }, () => queue.schedule(slow)));
        expect(most).toBe(2);
    });

    test("background work only gets slots nothing else wants", async () => {
        const queue = new RequestQueue(20);
        const order: Array<string> = [];
        const job = (name: string) => async (): Promise<void> => { order.push(name); };
        await Promise.all([
            queue.schedule(job("a")),
            queue.background.schedule(job("background")),
            queue.schedule(job("b")),
            queue.schedule(job("c")),
        ]);
        expect(order).toEqual(["a", "b", "c", "background"]);
    });

    test("errors reach the caller", async () => {
        const queue = new RequestQueue(1);
        expect(queue.schedule(() => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
    });
});

describe("request", () => {
    const failing = (status: number): UnexpectedResponseError => new UnexpectedResponseError(new Request("https://e621.net/posts.json"), new Response(null, { status }), "The socket connection was closed unexpectedly");

    test("retries a 200 whose body didn't make it", async () => {
        let calls = 0;
        const result = await request("test", async () => {
            if (++calls === 1) throw failing(200);
            return "ok";
        }, new RequestQueue(1));
        expect(result).toBe("ok");
        expect(calls).toBe(2);
    });

    test("doesn't retry a 404", async () => {
        let calls = 0;
        const run = request("test", () => {
            calls++;
            return Promise.reject(failing(404));
        }, new RequestQueue(1));
        expect(run).rejects.toBeInstanceOf(UnexpectedResponseError);
        await run.catch(() => null);
        expect(calls).toBe(1);
    });
});
