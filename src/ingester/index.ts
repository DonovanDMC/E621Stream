import Debug from "@yiffy/debug";

import { startBackfill } from "../backfill/runner.ts";
import { backfillEnabled, disabledSources, feedsKey, gitCommit, pollIntervalScale, retentionHours, redisPrefix, streamKey } from "../config.ts";
import { migrate } from "../db.ts";
import { AuthError, hasAuth } from "../e621.ts";
import { startLatencyWatch } from "../latency.ts";
import { markTrackingStart } from "../metrics.ts";
import redis from "../redis.ts";

import { startDataCounts } from "./data.ts";
import { failed, succeeded, type FeedIncident, type PollResult } from "./feedLog.ts";
import { Feed, FEEDS } from "./feeds.ts";
import { onWake, pollScale, startIdleWatch } from "./idle.ts";
import { PostsFeed } from "./posts.ts";
import { startRecoveryWatch } from "./recovery.ts";
import { UpdateFeed, UPDATES } from "./updates.ts";

interface Pollable {
    source: { intervalMS: number; name: string };
    poll(): Promise<PollResult>;
}

const AUTH_RETRY_MS = 60 * 60 * 1000;

export interface FeedHealth {
    error: string | null;
    interval_ms: number;
    last_failed_at: string | null;
    last_ok_at: string | null;
    outage: FeedIncident | null;
    published: number;
}

function parseHealth(stored: string | undefined): Partial<FeedHealth> {
    if (!stored) return {};
    try {
        return JSON.parse(stored) as Partial<FeedHealth>;
    } catch {
        return {};
    }
}

function run(feed: Pollable, stored: Partial<FeedHealth>): void {
    const { name, intervalMS } = feed.source;
    const interval = intervalMS * pollIntervalScale;
    const health: FeedHealth = { last_ok_at: null, last_failed_at: null, error: null, outage: null, published: 0, ...stored, interval_ms: interval };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async (): Promise<void> => {
        let next = interval * pollScale();
        try {
            const result = await feed.poll();
            if (result.published !== 0) Debug(`ingester:${name}`, `published ${result.published} event(s)`);
            health.last_ok_at = new Date().toISOString();
            health.published += result.published;
            health.error = null;
            await succeeded(name, health.outage, result).catch((err: unknown) => { Debug(`ingester:${name}`, `couldn't log: ${String(err)}`); });
            health.outage = null;
        } catch (err) {
            if (err instanceof AuthError) {
                Debug(`ingester:${name}`, `access denied (${err.message}), trying again in an hour`);
                next = AUTH_RETRY_MS;
            } else {
                Debug(`ingester:${name}`, `poll failed: ${String(err)}`);
            }
            health.last_failed_at = new Date().toISOString();
            health.error = String(err);
            health.outage = failed(name, health.outage, err);
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
    const minId = `${Date.now() - retentionHours * 60 * 60 * 1000}-0`;
    const removed = await redis.send("XTRIM", [streamKey, "MINID", "~", minId]) as number;
    if (removed !== 0) Debug("ingester:trim", `removed ${removed} expired event(s)`);
}

export async function startIngester(): Promise<void> {
    if (!hasAuth) throw new Error("E621_AUTH_USER and E621_AUTH_KEY are required for the ingester");
    await migrate();
    await redis.set(`${redisPrefix}:ingester:started_at`, new Date().toISOString());
    await redis.set(`${redisPrefix}:ingester:commit`, gitCommit);
    await startIdleWatch();
    await markTrackingStart();
    const feeds: Array<Pollable> = [new PostsFeed(), ...FEEDS.map(source => new Feed(source)), ...UPDATES.map(source => new UpdateFeed(source))];
    for (const feed of feeds) if (disabledSources.has(feed.source.name)) Debug("ingester", `${feed.source.name} is disabled`);
    const running = feeds.filter(feed => !disabledSources.has(feed.source.name));
    // health is kept across restarts, only feeds that aren't running anymore are dropped
    const stored = await redis.send("HGETALL", [feedsKey]) as Record<string, string> | null ?? {};
    const names = new Set(running.map(feed => feed.source.name));
    const gone = Object.keys(stored).filter(name => !names.has(name));
    if (gone.length !== 0) await redis.send("HDEL", [feedsKey, ...gone]);
    for (const feed of running) run(feed, parseHealth(stored[feed.source.name]));
    setInterval(() => void trim().catch((err: unknown) => { Debug("ingester:trim", `failed: ${String(err)}`); }), 60_000);
    startRecoveryWatch();
    await startLatencyWatch();
    if (backfillEnabled) startBackfill();
    startDataCounts();
}
