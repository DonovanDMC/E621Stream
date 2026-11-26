import { expect, test } from "bun:test";

import RequestQueue from "../../src/util/RequestQueue.ts";

// which of these start in what order, with everything queued before the first gets a turn
async function order(share: number, foreground: number, background: number): Promise<Array<string>> {
    const queue = new RequestQueue(2, false, share);
    const started: Array<string> = [];
    const run = (name: string) => async (): Promise<void> => {
        started.push(name);
    };
    // holds the queue until everything's waiting
    const hold = queue.schedule(async () => Bun.sleep(20));
    const all = [
        ...Array.from({ length: foreground }, (_, i) => queue.schedule(run(`f${i}`))),
        ...Array.from({ length: background }, (_, i) => queue.background.schedule(run(`b${i}`))),
    ];
    await Promise.all([hold, ...all]);
    return started;
}

test("background gets every nth start while foreground is waiting", async () => {
    // the hold counts as the first foreground start
    expect(await order(4, 8, 2)).toEqual(["f0", "f1", "b0", "f2", "f3", "f4", "b1", "f5", "f6", "f7"]);
});

test("without a share, background waits for foreground to run out", async () => {
    expect(await order(0, 4, 2)).toEqual(["f0", "f1", "f2", "f3", "b0", "b1"]);
});

test("background runs whenever foreground is empty", async () => {
    expect(await order(4, 0, 3)).toEqual(["b0", "b1", "b2"]);
});
