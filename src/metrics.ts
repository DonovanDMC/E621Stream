import { redisPrefix } from "./config.ts";
import redis from "./redis.ts";

const minuteKey = (minute: number): string => `${redisPrefix}:metrics:m:${minute}`;
const hourKey = (hour: number): string => `${redisPrefix}:metrics:h:${hour}`;
const totalsKey = `${redisPrefix}:metrics:total`;
const MINUTE_TTL_SECONDS = 2 * 60 * 60;
const HOUR_TTL_SECONDS = 8 * 24 * 60 * 60;
const FLUSH_MS = 5000;

let pending = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
    timer = null;
    const counts = pending;
    pending = new Map();
    const minute = Math.floor(Date.now() / 60_000), hour = Math.floor(minute / 60);
    const writes: Array<Promise<unknown>> = [];
    for (const [field, by] of counts) {
        for (const key of [minuteKey(minute), hourKey(hour), totalsKey]) writes.push(redis.send("HINCRBY", [key, field, String(by)]));
    }
    writes.push(redis.send("EXPIRE", [minuteKey(minute), String(MINUTE_TTL_SECONDS)]), redis.send("EXPIRE", [hourKey(hour), String(HOUR_TTL_SECONDS)]));
    await Promise.all(writes);
}

export function count(field: string, by = 1): void {
    pending.set(field, (pending.get(field) ?? 0) + by);
    if (!timer) {
        timer = setTimeout(() => void flush().catch(() => null), FLUSH_MS);
        timer.unref();
    }
}

export type Counts = Record<string, number>;

async function read(key: string): Promise<Counts> {
    const fields = await redis.send("HGETALL", [key]) as Record<string, string> | Array<string> | null;
    const entries: Array<[string, string]> = Array.isArray(fields) ? Array.from({ length: fields.length / 2 }, (_, i): [string, string] => [fields[i * 2]!, fields[i * 2 + 1]!]) : Object.entries(fields ?? {});
    return Object.fromEntries(entries.map(([k, v]) => [k, Number(v)]));
}

export async function recent(unit: "hour" | "minute", n: number): Promise<Array<{ at: number; counts: Counts }>> {
    const now = Math.floor(Date.now() / (unit === "minute" ? 60_000 : 3_600_000));
    const slots = Array.from({ length: n }, (_, i) => now - n + 1 + i);
    return Promise.all(slots.map(async slot => ({ at: slot * (unit === "minute" ? 60_000 : 3_600_000), counts: await read(unit === "minute" ? minuteKey(slot) : hourKey(slot)) })));
}

export const totals = (): Promise<Counts> => read(totalsKey);
