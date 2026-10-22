import Debug from "@yiffy/debug";

import { startBackfill } from "../backfill/runner.ts";
import { backfillEnabled, disabledSources, feedsKey, pollIntervalScale, retentionHours, redisPrefix, streamKey } from "../config.ts";
import { migrate } from "../db.ts";
import { AuthError, hasAuth } from "../e621.ts";
import redis from "../redis.ts";

import { startDataCounts } from "./data.ts";
import { Feed, FEEDS } from "./feeds.ts";
import { idleScale, onWake, startIdleWatch } from "./idle.ts";
import { PostsFeed } from "./posts.ts";
import { UpdateFeed, UPDATES } from "./updates.ts";

interface Pollable {
    source: { intervalMS: number; name: string };
    poll(): Promise<number>;
}

const AUTH_RETRY_MS = 60 * 60 * 1000;

export interface FeedHealth {
    error: string | null;
    interval_ms: number;
    last_failed_at: string | null;
    last_ok_at: string | null;
    published: number;
}

function run(feed: Pollable): void {
    const { name, intervalMS } = feed.source;
    const interval = intervalMS * pollIntervalScale;
    const health: FeedHealth = { interval_ms: interval, last_ok_at: null, last_failed_at: null, error: null, published: 0 };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async (): Promise<void> => {
        let next = interval * idleScale();
        try {
            const count = await feed.poll();
            if (count !== 0) Debug(`ingester:${name}`, `published ${count} event(s)`);
            health.last_ok_at = new Date().toISOString();
            health.published += count;
            health.error = null;
        } catch (err) {
            if (err instanceof AuthError) {
                Debug(`ingester:${name}`, `access denied (${err.message}), trying again in an hour`);
                next = AUTH_RETRY_MS;
            } else {
                Debug(`ingester:${name}`, `poll failed: ${String(err)}`);
            }
            health.last_failed_at = new Date().toISOString();
            health.error = String(err);
        }
        health.interval_ms = next;
        await redis.hset(feedsKey, name, JSON.stringify(health)).catch(() => null);
        timer = setTimeout(() => {
            timer = null;
            void loop();
        }, next);
    };
    onWake(() => {
        if (!timer || health.interval_ms === AUTH_RETRY_MS) return;
        clearTimeout(timer);
        timer = null;
        void loop();
    });
    void loop();
}

async function trim(): Promise<void> {
    // stream ids start with a timestamp
    const minId = `${Date.now() - retentionHours * 60 * 60 * 1000}-0`;
    const removed = await redis.send("XTRIM", [streamKey, "MINID", "~", minId]) as number;
    if (removed !== 0) Debug("ingester:trim", `removed ${removed} expired event(s)`);
}

export async function startIngester(): Promise<void> {
    if (!hasAuth) throw new Error("E621_AUTH_USER and E621_AUTH_KEY are required for the ingester");
    await migrate();
    await redis.del(feedsKey);
    await redis.set(`${redisPrefix}:ingester:started_at`, new Date().toISOString());
    await startIdleWatch();
    const feeds: Array<Pollable> = [new PostsFeed(), ...FEEDS.map(source => new Feed(source)), ...UPDATES.map(source => new UpdateFeed(source))];
    for (const feed of feeds) {
        if (disabledSources.has(feed.source.name)) {
            Debug("ingester", `${feed.source.name} is disabled`);
            continue;
        }
        run(feed);
    }
    setInterval(() => void trim().catch((err: unknown) => { Debug("ingester:trim", `failed: ${String(err)}`); }), 60_000);
    if (backfillEnabled) startBackfill();
    startDataCounts();
}
