import Debug from "@yiffy/debug";

import { disabledSources, pollIntervalScale, retentionHours, streamKey } from "../config.ts";
import { AuthError, hasAuth } from "../e621.ts";
import redis from "../redis.ts";

import { Feed, FEEDS } from "./feeds.ts";

interface Pollable {
    source: { intervalMS: number; name: string };
    poll(): Promise<number>;
}

const AUTH_RETRY_MS = 60 * 60 * 1000;

function run(feed: Pollable): void {
    const { name, intervalMS } = feed.source;
    const interval = intervalMS * pollIntervalScale;
    const loop = async (): Promise<void> => {
        let next = interval;
        try {
            const count = await feed.poll();
            if (count !== 0) Debug(`ingester:${name}`, `published ${count} event(s)`);
        } catch (err) {
            if (err instanceof AuthError) {
                Debug(`ingester:${name}`, `access denied (${err.message}), trying again in an hour`);
                next = AUTH_RETRY_MS;
            } else {
                Debug(`ingester:${name}`, `poll failed: ${String(err)}`);
            }
        }
        setTimeout(() => void loop(), next);
    };
    void loop();
}

async function trim(): Promise<void> {
    // stream ids start with a timestamp
    const minId = `${Date.now() - retentionHours * 60 * 60 * 1000}-0`;
    const removed = await redis.send("XTRIM", [streamKey, "MINID", "~", minId]) as number;
    if (removed !== 0) Debug("ingester:trim", `removed ${removed} expired event(s)`);
}

export function startIngester(): void {
    if (!hasAuth) throw new Error("E621_AUTH_USER and E621_AUTH_KEY are required for the ingester");
    const feeds: Array<Pollable> = FEEDS.map(source => new Feed(source));
    for (const feed of feeds) {
        if (disabledSources.has(feed.source.name)) {
            Debug("ingester", `${feed.source.name} is disabled`);
            continue;
        }
        run(feed);
    }
    setInterval(() => void trim().catch((err: unknown) => { Debug("ingester:trim", `failed: ${String(err)}`); }), 60_000);
}
