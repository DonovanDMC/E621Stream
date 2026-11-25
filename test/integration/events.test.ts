import { beforeEach, expect, test } from "bun:test";

import Redis, { parseEntry, type StreamEntry } from "../../src/db/Redis.ts";
import { latestEvent, publish, publishNotice, streamKey } from "../../src/gateway/events.ts";
import { recoveryContext } from "../../src/gateway/recovery.ts";
import { reset } from "../helpers.ts";

beforeEach(reset);

const all = async (): Promise<Array<Record<string, unknown>>> => (await Redis.send("XRANGE", [streamKey, "-", "+"]) as Array<StreamEntry>).map(parseEntry) as never;

test("events are stored with their type, time and data", async () => {
    const id = await publish("tag.update", "2026-11-01T00:00:00Z", { id: 1, name: "fox" } as never, { updater_id: 5 });
    expect(await all()).toEqual([{ id, type: "tag.update", time: "2026-11-01T00:00:00Z", recovered: false, data: { id: 1, name: "fox" }, context: { updater_id: 5 } }]);
});

test("an empty context isn't stored", async () => {
    await publish("tag.update", "2026-11-01T00:00:00Z", { id: 1 } as never, {});
    expect((await all())[0]).not.toHaveProperty("context");
});

test("events published during a recovery are marked", async () => {
    await recoveryContext.run("r1", () => publish("tag.update", "2026-11-01T00:00:00Z", { id: 1 } as never));
    expect((await all())[0]?.recovered).toBe(true);
});

test("latestEvent skips notices", async () => {
    expect(await latestEvent()).toBeNull();
    const id = await publish("tag.update", "2026-11-01T00:00:00Z", { id: 1 } as never);
    await publishNotice("slow_mode", { enabled: true, scale: 2, since: "2026-11-01T00:00:00Z" });
    expect(await latestEvent()).toEqual({ id, time: "2026-11-01T00:00:00Z" });
});
