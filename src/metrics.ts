import { redisPrefix } from "./config.ts";
import redis from "./redis.ts";

// counters for the status page. each count goes into a hash per minute, a hash per hour, and an all time hash. the
// field is what's being counted ("events", "events.post.update", "requests.ingester", "request_ms.gateway", ...),
// sums like request_ms are divided by their count to get an average
// counts are held in memory and written every few seconds so a busy feed isn't a redis call per event

const minuteKey = (minute: number): string => `${redisPrefix}:metrics:m:${minute}`;
const hourKey = (hour: number): string => `${redisPrefix}:metrics:h:${hour}`;
const totalsKey = `${redisPrefix}:metrics:total`;
// when counting started, the status page shows it next to the totals
const sinceKey = `${redisPrefix}:metrics:since`;
// the status page only goes back an hour by minute and a day by hour, these are kept a bit longer than that
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

// unref'd, so a pending flush never keeps the process (or a test) alive
export function count(field: string, by = 1): void {
    pending.set(field, (pending.get(field) ?? 0) + by);
    if (!timer) {
        timer = setTimeout(() => void flush().catch(() => null), FLUSH_MS);
        timer.unref();
    }
}

export type Counts = Record<string, number>;

// HGETALL comes back as an object or a flat list depending on the redis protocol version
async function read(key: string): Promise<Counts> {
    const fields = await redis.send("HGETALL", [key]) as Record<string, string> | Array<string> | null;
    const entries: Array<[string, string]> = Array.isArray(fields) ? Array.from({ length: fields.length / 2 }, (_, i): [string, string] => [fields[i * 2]!, fields[i * 2 + 1]!]) : Object.entries(fields ?? {});
    return Object.fromEntries(entries.map(([k, v]) => [k, Number(v)]));
}

// the last n minutes or hours, oldest first, the current one included. `at` is the start of each in ms
export async function recent(unit: "hour" | "minute", n: number): Promise<Array<{ at: number; counts: Counts }>> {
    const now = Math.floor(Date.now() / (unit === "minute" ? 60_000 : 3_600_000));
    const slots = Array.from({ length: n }, (_, i) => now - n + 1 + i);
    return Promise.all(slots.map(async slot => ({ at: slot * (unit === "minute" ? 60_000 : 3_600_000), counts: await read(unit === "minute" ? minuteKey(slot) : hourKey(slot)) })));
}

export const totals = (): Promise<Counts> => read(totalsKey);

export const trackingSince = (): Promise<string | null> => redis.get(sinceKey);

// sets sinceKey once, on the ingester's first start
export async function markTrackingStart(): Promise<void> {
    if (await redis.exists(sinceKey)) return;
    // tracking started before this existed, the oldest hour still around is close enough
    let cursor = "0", oldest = Infinity;
    do {
        const [next, keys] = await redis.send("SCAN", [cursor, "MATCH", `${redisPrefix}:metrics:h:*`, "COUNT", "1000"]) as [string, Array<string>];
        cursor = next;
        for (const key of keys) oldest = Math.min(oldest, Number(key.slice(key.lastIndexOf(":") + 1)));
    } while (cursor !== "0");
    const since = Number.isFinite(oldest) ? new Date(oldest * 3_600_000) : new Date();
    await redis.send("SET", [sinceKey, since.toISOString(), "NX"]);
}
