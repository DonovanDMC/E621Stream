import Debug from "@yiffy/debug";

import { discordWebhookURL, latencyAlertMS, latencyKey, oauthRedirectURI } from "./config.ts";
import redis from "./redis.ts";
import { getSlowMode } from "./slowMode.ts";

// watches how long e621 takes to answer, and posts to DISCORD_WEBHOOK_URL when it's slow and when it recovers
// every request to e621 is recorded by the fetch wrapper in logs.ts, only the ingester watches them (from
// ingester/index.ts) since it makes nearly all of them. the time is until the headers came back, a timeout or
// network error counts as the full timeout
// it's elevated once the median over the last 5 minutes reaches LATENCY_ALERT_MS, and recovered after 3 checks in a
// row under it, so it doesn't flap. the state is kept in redis so a restart doesn't post again, and the admin page
// can show it

const WINDOW_MS = 5 * 60_000;
const CHECK_MS = 60_000;
// fewer than this in the window (slow mode, a quiet restart) isn't enough to go on, the state is left as it is
const MIN_SAMPLES = 10;
const RECOVER_CHECKS = 3;

export interface Latency {
    checked_at: string;
    elevated: boolean;
    failed: number;
    p50: number;
    p90: number;
    requests: number;
    // when it last went elevated or recovered
    since: string;
}

export interface Sample {
    at: number;
    failed: boolean;
    ms: number;
}

const samples: Array<Sample> = [];

export function recordRequest(ms: number, failed: boolean): void {
    const now = Date.now();
    samples.push({ at: now, failed, ms });
    while (samples[0]!.at < now - WINDOW_MS) samples.shift();
}

export async function getLatency(): Promise<Latency | null> {
    const raw = await redis.get(latencyKey);
    return raw ? JSON.parse(raw) as Latency : null;
}

const percentile = (sorted: Array<number>, p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function duration(from: string): string {
    const minutes = Math.round((Date.now() - Date.parse(from)) / 60_000);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

async function post(title: string, color: number, latency: Latency, extra: string): Promise<void> {
    if (!discordWebhookURL) return;
    const description = `Median ${seconds(latency.p50)}, p90 ${seconds(latency.p90)} over the last 5 minutes (${latency.requests} requests, ${latency.failed} failed).\n${extra}`;
    const res = await fetch(discordWebhookURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [{ title, description, color, timestamp: latency.checked_at }] }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`discord returned ${res.status}`);
}

// what the watch carries between checks. calm is how many checks in a row have been under the limit
export interface LatencyState {
    calm: number;
    latency: Latency | null;
}

// the next state from the last 5 minutes of requests, pulled out of check() so it can be tested. change says whether
// it just went elevated or recovered, elevatedAt is when it went elevated for a recovery
export function evaluate(state: LatencyState, recent: Array<Sample>, now = new Date()): LatencyState & { change: "elevated" | "recovered" | null; elevatedAt?: string } {
    if (recent.length < MIN_SAMPLES) return { ...state, change: null };
    const sorted = recent.map(sample => sample.ms).sort((a, b) => a - b);
    const at = now.toISOString();
    const latency: Latency = {
        checked_at: at,
        elevated: state.latency?.elevated ?? false,
        failed: recent.filter(sample => sample.failed).length,
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        requests: recent.length,
        since: state.latency?.since ?? at,
    };
    const slow = latency.p50 >= latencyAlertMS;
    const calm = slow ? 0 : state.calm + 1;
    if (!latency.elevated && slow) return { calm, latency: { ...latency, elevated: true, since: at }, change: "elevated" };
    if (latency.elevated && calm >= RECOVER_CHECKS) return { calm, latency: { ...latency, elevated: false, since: at }, change: "recovered", elevatedAt: latency.since };
    return { calm, latency, change: null };
}

async function check(state: LatencyState): Promise<LatencyState> {
    const next = evaluate(state, samples.filter(sample => sample.at >= Date.now() - WINDOW_MS));
    const { latency } = next;
    if (!latency || latency === state.latency) return next;
    const admin = new URL("/admin", oauthRedirectURI).href;
    const failed = (err: unknown): void => { Debug("ingester:latency", `couldn't post to discord: ${String(err)}`); };
    if (next.change === "elevated") {
        Debug("ingester:latency", `request times are elevated, median ${latency.p50}ms`);
        const mode = await getSlowMode();
        await post("e621 request times are elevated", 0xE5_48_4D, latency, mode ? `Slow mode is on (${mode.scale}x).` : `Slow mode can be turned on from ${admin}`).catch(failed);
    } else if (next.change === "recovered") {
        const took = duration(next.elevatedAt!);
        Debug("ingester:latency", `request times recovered after ${took}, median ${latency.p50}ms`);
        const mode = await getSlowMode();
        await post("e621 request times have recovered", 0x30_A4_6C, latency, `They were elevated for ${took}.${mode ? ` Slow mode is still on (${mode.scale}x), it can be turned off from ${admin}` : ""}`).catch(failed);
    }
    await redis.set(latencyKey, JSON.stringify(latency));
    return next;
}

export async function startLatencyWatch(): Promise<void> {
    let state: LatencyState = { calm: 0, latency: await getLatency() };
    setInterval(() => {
        void check(state)
            .then((next) => { state = next; })
            .catch((err: unknown) => { Debug("ingester:latency", `check failed: ${String(err)}`); });
    }, CHECK_MS);
}
