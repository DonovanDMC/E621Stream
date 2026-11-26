import Config from "../config/Config.ts";
import Redis from "../db/Redis.ts";

import type { FeedIncident } from "./feedLog.ts";

const feedsKey = `${Config.redisPrefix}feeds`;

export interface FeedHealth {
    error: string | null;
    interval_ms: number;
    last_failed_at: string | null; // ISO timestamp
    last_ok_at: string | null; // ISO timestamp
    outage: FeedIncident | null;
    /** Paused from the admin page */
    paused: boolean;
    published: number;
}

function parse(stored: string | undefined): Partial<FeedHealth> {
    if (!stored) return {};
    try {
        return JSON.parse(stored) as Partial<FeedHealth>;
    } catch {
        return {};
    }
}

export async function getFeedHealth(): Promise<Record<string, Partial<FeedHealth>>> {
    const stored = await Redis.hgetall(feedsKey);
    return Object.fromEntries(Object.entries(stored).map(([name, value]) => [name, parse(value)]));
}

/** Kept across restarts, so only feeds that aren't running anymore are dropped */
export async function loadFeedHealth(running: Array<string>): Promise<Record<string, Partial<FeedHealth>>> {
    const health = await getFeedHealth();
    const gone = Object.keys(health).filter(name => !running.includes(name));
    if (gone.length !== 0) await Redis.hdel(feedsKey, ...gone as [string, ...Array<string>]);
    return health;
}

export async function saveFeedHealth(name: string, health: FeedHealth): Promise<void> {
    await Redis.hset(feedsKey, name, JSON.stringify(health));
}
