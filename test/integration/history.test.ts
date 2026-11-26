import { beforeEach, expect, test } from "bun:test";

import Redis, { objectToFields, parseEntry, type StreamEntry } from "../../src/db/Redis.ts";
import { publish, publishNotice, streamKey, type StreamItem } from "../../src/gateway/events.ts";
import { itemsAfter, oldestID, storedCount } from "../../src/gateway/history.ts";
import { archive, expire } from "../../src/ingester/archive.ts";
import { reset } from "../helpers.ts";

beforeEach(reset);

const HOUR_MS = 60 * 60 * 1000;
const onStream = async (): Promise<Array<string>> => (await Redis.send("XRANGE", [streamKey, "-", "+"]) as Array<StreamEntry>).map(([id]) => id);
const all = async (cursor = "0-0", batch = 500): Promise<Array<StreamItem>> => {
    const items: Array<StreamItem> = [];
    for await (const batchItems of itemsAfter(cursor, batch)) items.push(...batchItems);
    return items;
};
// published with an id from the past, the stream has to be empty or older for it
const publishAt = async (ms: number, id: number): Promise<string> => Redis.send("XADD", [streamKey, `${ms}-0`, ...objectToFields({ type: "tag.update", time: new Date(ms).toISOString(), recovered: false, data: { id } })]) as Promise<string>;

test("archiving copies events and notices as they are on the stream", async () => {
    await publish("tag.update", "2026-11-01T00:00:00Z", { id: 1, name: "fox" } as never, { updater_id: 5 });
    await publishNotice("slow_mode", { enabled: true, scale: 2, since: "2026-11-01T00:00:00Z" });
    const expected = (await Redis.send("XRANGE", [streamKey, "-", "+"]) as Array<StreamEntry>).map(parseEntry);
    expect(await archive()).toBe(2);
    expect(await archive()).toBe(0);
    expect(await storedCount()).toBe(2);
    // read straight from postgres
    await Redis.send("DEL", [streamKey]);
    expect(await all()).toEqual(expected as Array<StreamItem>);
});

test("reading goes from the history onto the stream without gaps or repeats", async () => {
    const ids: Array<string> = [];
    for (let i = 1; i <= 5; i++) ids.push(await publish("tag.update", "2026-11-01T00:00:00Z", { id: i } as never));
    await archive();
    // like the stream being trimmed past them
    await Redis.send("XDEL", [streamKey, ids[0]!, ids[1]!]);
    for (let i = 6; i <= 8; i++) ids.push(await publish("tag.update", "2026-11-01T00:00:00Z", { id: i } as never));
    expect((await all("0-0", 2)).map(item => item.id)).toEqual(ids);
    expect((await all(ids[3], 2)).map(item => item.id)).toEqual(ids.slice(4));
});

test("the stream is trimmed to the live period, but never past what's been copied", async () => {
    const old = Date.now() - HOUR_MS;
    const a = await publishAt(old, 1), b = await publishAt(old + 1, 2);
    await archive();
    // b is kept, it's the newest copied
    expect(await onStream()).toEqual([b]);
    expect((await all()).map(item => item.id)).toEqual([a, b]);
    const c = await publish("tag.update", "2026-11-01T00:00:00Z", { id: 3 } as never);
    await archive();
    // c is in the live period, so b can go
    expect(await onStream()).toEqual([c]);
    expect((await all()).map(item => item.id)).toEqual([a, b, c]);
});

test("hours older than the replay period are dropped", async () => {
    const old = await publishAt(Date.now() - (100 * HOUR_MS), 1);
    const kept = await publish("tag.update", "2026-11-01T00:00:00Z", { id: 2 } as never);
    await archive();
    expect(await oldestID()).toBe(old);
    expect((await expire()).length).toBe(1);
    expect((await all()).map(item => item.id)).toEqual([kept]);
    expect(await oldestID()).toBe(kept);
});
