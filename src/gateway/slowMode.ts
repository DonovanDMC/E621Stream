import Config from "../config/Config.ts";
import Redis from "../db/Redis.ts";

import { publishNotice, type Notice } from "./events.ts";

const slowModeKey = `${Config.redisPrefix}slow_mode`;

export interface SlowModeNotice extends Notice<"slow_mode"> {
    enabled: boolean;
    scale: number | null;
    since: string; // ISO timestamp
}

export interface SlowMode {
    at: string; // ISO timestamp
    by: string;
    scale: number;
}

export async function getSlowMode(): Promise<SlowMode | null> {
    const raw = await Redis.get(slowModeKey);
    return raw ? JSON.parse(raw) as SlowMode : null;
}

export async function setSlowMode(scale: number, by: string): Promise<void> {
    const mode: SlowMode = { scale, by, at: new Date().toISOString() };
    await Redis.set(slowModeKey, JSON.stringify(mode));
    await publishNotice("slow_mode", { enabled: true, scale, since: mode.at });
}

export async function clearSlowMode(): Promise<void> {
    if (await Redis.del(slowModeKey) === 0) return;
    await publishNotice("slow_mode", { enabled: false, scale: null, since: new Date().toISOString() });
}
