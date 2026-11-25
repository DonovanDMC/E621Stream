import Config from "../Config.ts";
import Redis from "../db/Redis.ts";

const minuteKey = (minute: number): string => `${Config.redisPrefix}metrics:m:${minute}`;
const hourKey = (hour: number): string => `${Config.redisPrefix}metrics:h:${hour}`;
const totalsKey = `${Config.redisPrefix}metrics:total`;
const sinceKey = `${Config.redisPrefix}metrics:since`;
const MINUTE_TTL_SECONDS = 2 * 60 * 60;
const HOUR_TTL_SECONDS = 8 * 24 * 60 * 60;
const FLUSH_MS = 5000;

let pending = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;

async function flush(): Promise<void> {
    timer = null;
    const counts = pending;
    pending = new Map();
    const minute = Math.floor(Date.now() / 60_000), hour = Math.floor(minute / 60);
    const writes: Array<Promise<unknown>> = [];
    for (const [field, by] of counts) {
        for (const key of [minuteKey(minute), hourKey(hour), totalsKey]) writes.push(Redis.hincrby(key, field, by));
    }
    writes.push(Redis.expire(minuteKey(minute), MINUTE_TTL_SECONDS), Redis.expire(hourKey(hour), HOUR_TTL_SECONDS));
    await Promise.all(writes);
}

export function count(field: string, by = 1): void {
    pending.set(field, (pending.get(field) ?? 0) + by);
    if (!timer) {
        timer = setTimeout(() => void flush().catch((err: unknown) => { console.error(`Failed to flush redis metrics: ${String(err)}`); }), FLUSH_MS);
        timer.unref();
    }
}

export type Counts = Record<string, number>;

async function read(key: string): Promise<Counts> {
    const fields = await Redis.hgetall(key);
    return Object.fromEntries(Object.entries(fields).map(([key, v]) => [key, Number(v)]));
}

export async function recent(unit: "hour" | "minute", value: number): Promise<Array<{ at: number; counts: Counts }>> {
    const m = 60_000, h = m * 60;
    const now = Math.floor(Date.now() / (unit === "minute" ? m : h));
    const slots = Array.from({ length: value }, (_, i) => now - value + 1 + i);
    return Promise.all(slots.map(async slot => ({
        at: slot * (unit === "minute" ? m : h),
        counts: await read(unit === "minute" ? minuteKey(slot) : hourKey(slot)),
    })));
}

export async function totals(): Promise<Counts> {
    return read(totalsKey);
}

export async function trackingSince(): Promise<string | null> {
    return Redis.get(sinceKey);
}

export async function markTrackingStart(): Promise<void> {
    if (await Redis.exists(sinceKey)) return;
    let cursor = "0", oldest = Infinity;
    do {
        const [next, keys] = await Redis.scan(cursor, "MATCH", `${Config.redisPrefix}metrics:h:*`, "COUNT", 1000);
        cursor = next;
        for (const key of keys) oldest = Math.min(oldest, Number(key.slice(key.lastIndexOf(":") + 1)));
    } while (cursor !== "0");
    const since = Number.isFinite(oldest) ? new Date(oldest * 60_000 * 60) : new Date();
    await Redis.set(sinceKey, since.toISOString(), "NX");
}
