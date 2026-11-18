import { slowModeKey } from "./config.ts";
import { publishNotice } from "./events.ts";
import redis from "./redis.ts";

// polling feeds slower while e621 is struggling, turned on & off from the admin page without a redeploy
// it stacks with POLL_INTERVAL_SCALE and idle. the ingester picks it up in ingester/idle.ts
// clients get a slow_mode notice when it changes, and the current one in ready

export interface SlowMode {
    at: string;
    by: string;
    // what feed intervals are multiplied by
    scale: number;
}

// what clients get. scale is null when it's off, since is when it was turned on or off
export interface SlowModeNotice {
    enabled: boolean;
    scale: number | null;
    since: string;
}

export const slowNotice = (mode: SlowMode): SlowModeNotice => ({ enabled: true, scale: mode.scale, since: mode.at });

export async function getSlowMode(): Promise<SlowMode | null> {
    const raw = await redis.get(slowModeKey);
    return raw ? JSON.parse(raw) as SlowMode : null;
}

export async function setSlowMode(scale: number, by: string): Promise<void> {
    const mode: SlowMode = { scale, by, at: new Date().toISOString() };
    await redis.set(slowModeKey, JSON.stringify(mode));
    await publishNotice("slow_mode", slowNotice(mode));
}

// nothing's sent if it was already off
export async function clearSlowMode(): Promise<void> {
    if (await redis.del(slowModeKey) === 0) return;
    await publishNotice("slow_mode", { enabled: false, scale: null, since: new Date().toISOString() });
}
