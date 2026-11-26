import { beforeEach, expect, test } from "bun:test";

import Config from "../../src/config/Config.ts";
import Backfill from "../../src/db/models/Backfill.ts";
import Redis from "../../src/db/Redis.ts";
import { runBackfill, type Crawl } from "../../src/ingester/backfill.ts";
import { reset } from "../helpers.ts";

beforeEach(reset);

// pages of 320 counting down from the page asked for, onPage runs before each one is returned
function fakeCrawl(onPage: (page: number) => Promise<void>): Crawl & { saved: number } {
    const crawl = {
        name: "fake",
        cursor: "fake",
        ownRequests: true,
        saved: 0,
        async search({ page }: { page: `b${number}` }): Promise<Array<{ id: number }>> {
            const before = Number(page.slice(1));
            await onPage(before);
            return Array.from({ length: Math.min(320, before - 1) }, (_, i) => ({ id: before - 1 - i }));
        },
        async save(items: Array<{ id: number }>): Promise<void> {
            crawl.saved += items.length;
        },
    };
    return crawl;
}

test("a crawl finishes and is marked done", async () => {
    await Redis.hset(`${Config.redisPrefix}cursors`, "fake", "1000");
    const crawl = fakeCrawl(async () => undefined);
    expect(await runBackfill(crawl)).toBe(true);
    expect((await Backfill.find("fake"))?.status).toBe("done");
    expect(crawl.saved).toBe(1000);
});

test("resetting a running crawl stops it instead of leaving a half made row", async () => {
    await Redis.hset(`${Config.redisPrefix}cursors`, "fake", "100000");
    let pages = 0;
    const crawl = fakeCrawl(async () => {
        if (++pages === 3) await (await Backfill.find("fake"))?.destroy();
    });
    expect(await runBackfill(crawl)).toBe(false);
    expect(await Backfill.find("fake")).toBeNull();
    // a few pages in flight finish, not the 300 or so it'd take to get through
    expect(pages).toBeLessThan(10);
});
