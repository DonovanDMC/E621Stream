import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import IngesterConfig from "../config/IngesterConfig.ts";
import Redis from "../db/Redis.ts";
import { AuthError } from "../util/errors.ts";
import { startLogging } from "../util/FileLog.ts";
import { startLatencyWatch } from "../util/latency.ts";
import { markTrackingStart } from "../util/metrics.ts";
import { checkServices } from "../util/util.ts";

import { startArchive } from "./archive.ts";
import { startBackfill } from "./backfill.ts";
import { feedScale, isPaused, startControlWatch } from "./control.ts";
import { startDataCounts } from "./data.ts";
import { failed, succeeded, type PollResult } from "./feedLog.ts";
import { Feed, FEEDS } from "./feeds.ts";
import { loadFeedHealth, saveFeedHealth, type FeedHealth } from "./health.ts";
import { onWake, pollScale, startIdleWatch } from "./idle.ts";
import { PostsFeed } from "./posts.ts";
import { startRecoveryWatch } from "./recovery.ts";
import { UpdateFeed, UPDATES } from "./updates.ts";

await startLogging("ingester");
await checkServices();
// before anything's written to redis, so a stream that filled it is trimmed first
await startArchive();

interface Pollable {
    source: { intervalMS: number; name: string };
    poll(): Promise<PollResult>;
}

const AUTH_RETRY_MS = 60 * 60 * 1000;
// paused feeds are woken when they're resumed, this is just in case that's missed
const PAUSED_CHECK_MS = 60_000;
const wakers = new Map<string, () => void>();

function run(feed: Pollable, stored: Partial<FeedHealth>): void {
    const { name, intervalMS } = feed.source;
    const interval = intervalMS * IngesterConfig.pollIntervalScale;
    const health: FeedHealth = { last_ok_at: null, last_failed_at: null, error: null, outage: null, published: 0, ...stored, interval_ms: interval, paused: false };
    let timer: NodeJS.Timeout | null = null;
    // how long until the next poll
    const poll = async (next: number): Promise<number> => {
        try {
            const result = await feed.poll();
            if (result.published !== 0) Debug(`ingester:${name}`, `published ${result.published} event(s)`);
            health.last_ok_at = new Date().toISOString();
            health.published += result.published;
            health.error = null;
            await succeeded(name, health.outage, result).catch((err: unknown) => { Debug(`ingester:${name}`, `couldn't log: ${String(err)}`); });
            health.outage = null;
            return next;
        } catch (err) {
            health.last_failed_at = new Date().toISOString();
            health.error = String(err);
            health.outage = failed(name, health.outage, err);
            if (err instanceof AuthError) {
                Debug(`ingester:${name}`, `access denied (${err.message}), trying again in an hour`);
                return AUTH_RETRY_MS;
            }
            Debug(`ingester:${name}`, `poll failed: ${String(err)}`);
            return next;
        }
    };
    const loop = async (): Promise<void> => {
        health.paused = isPaused(name);
        const next = health.paused ? PAUSED_CHECK_MS : await poll(interval * pollScale() * feedScale(name));
        health.interval_ms = next;
        await saveFeedHealth(name, health).catch(() => null);
        timer = setTimeout(() => {
            timer = null;
            void loop();
        }, next);
    };
    // a feed waiting out an auth error isn't woken early
    const wake = (): void => {
        if (!timer || health.interval_ms === AUTH_RETRY_MS) return;
        clearTimeout(timer);
        timer = null;
        void loop();
    };
    onWake(wake);
    wakers.set(name, wake);
    void loop();
}

await Redis.set(`${Config.redisPrefix}ingester:started_at`, new Date().toISOString());
await Redis.set(`${Config.redisPrefix}ingester:version`, Config.version);
await startIdleWatch();
await startControlWatch(name => wakers.get(name)?.());
await markTrackingStart();

const feeds: Array<Pollable> = [new PostsFeed(), ...FEEDS.map(source => new Feed(source)), ...UPDATES.map(source => new UpdateFeed(source))];
for (const feed of feeds) if (IngesterConfig.disabledSources.includes(feed.source.name)) Debug("ingester", `${feed.source.name} is disabled`);
const running = feeds.filter(feed => !IngesterConfig.disabledSources.includes(feed.source.name));
const health = await loadFeedHealth(running.map(feed => feed.source.name));
for (const feed of running) run(feed, health[feed.source.name] ?? {});

startRecoveryWatch();
await startLatencyWatch();
if (IngesterConfig.backfillEnabled) startBackfill();
startDataCounts();
Debug("ingester", `polling ${running.length} feed(s)`);
