import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import Redis from "../db/Redis.ts";

const controlKey = `${Config.redisPrefix}feeds:control`;
const CHECK_MS = 5000;

/** Set from the admin page, for one feed at a time */
export interface FeedControl {
    paused: { at: string; by: string } | null;
    slow: { at: string; by: string; scale: number } | null;
}

export async function getFeedControls(): Promise<Record<string, FeedControl>> {
    const stored = await Redis.hgetall(controlKey);
    return Object.fromEntries(Object.entries(stored).map(([name, value]) => [name, JSON.parse(value) as FeedControl]));
}

async function change(name: string, patch: Partial<FeedControl>): Promise<void> {
    const current = (await getFeedControls())[name] ?? { paused: null, slow: null };
    const next = { ...current, ...patch };
    // nothing left to control, so it's dropped
    if (next.paused === null && next.slow === null) await Redis.hdel(controlKey, name);
    else await Redis.hset(controlKey, name, JSON.stringify(next));
}

export async function pauseFeed(name: string, by: string): Promise<void> {
    await change(name, { paused: { at: new Date().toISOString(), by } });
}

export async function resumeFeed(name: string): Promise<void> {
    await change(name, { paused: null });
}

export async function slowFeed(name: string, scale: number, by: string): Promise<void> {
    await change(name, { slow: { at: new Date().toISOString(), by, scale } });
}

export async function clearFeedSlow(name: string): Promise<void> {
    await change(name, { slow: null });
}

let controls: Record<string, FeedControl> = {};

export const isPaused = (name: string): boolean => controls[name]?.paused != null;
export const feedScale = (name: string): number => controls[name]?.slow?.scale ?? 1;

// a feed that was resumed or sped up is polled right away, instead of after the rest of its wait
async function check(wake: (name: string) => void): Promise<void> {
    const before = controls;
    controls = await getFeedControls();
    const names = new Set([...Object.keys(before), ...Object.keys(controls)]);
    for (const name of names) {
        const paused = controls[name]?.paused != null, wasPaused = before[name]?.paused != null;
        const scale = controls[name]?.slow?.scale ?? 1, wasScale = before[name]?.slow?.scale ?? 1;
        if (paused !== wasPaused) Debug(`ingester:${name}`, paused ? `paused by ${controls[name]!.paused!.by}` : "resumed");
        if (scale !== wasScale) Debug(`ingester:${name}`, scale === 1 ? "back to its normal speed" : `polled ${scale}x slower`);
        if ((wasPaused && !paused) || scale < wasScale) wake(name);
    }
}

export async function startControlWatch(wake: (name: string) => void): Promise<void> {
    await check(() => {}).catch(() => null);
    setInterval(() => void check(wake).catch((err: unknown) => { Debug("ingester", `feed control check failed: ${String(err)}`); }), CHECK_MS);
}
