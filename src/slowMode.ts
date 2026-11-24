import { slowModeKey } from "./config.ts";
import { publishNotice } from "./events.ts";
import redis from "./redis.ts";

export interface SlowMode {
    at: string;
    by: string;
    scale: number;
}

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

export async function clearSlowMode(): Promise<void> {
    if (await redis.del(slowModeKey) === 0) return;
    await publishNotice("slow_mode", { enabled: false, scale: null, since: new Date().toISOString() });
}
