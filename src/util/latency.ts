import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import IngesterConfig from "../config/IngesterConfig.ts";
import Redis from "../db/Redis.ts";
import { getSlowMode } from "../gateway/slowMode.ts";

import { logDiscord } from "./Discord.ts";

const latencyKey = `${Config.redisPrefix}latency`;
const WINDOW_MS = 5 * 60_000;
const CHECK_MS = 60_000;
const MIN_SAMPLES = 10;
// checks in a row under the limit before it counts as recovered
const RECOVER_CHECKS = 3;

export interface Latency {
    checked_at: string; // ISO timestamp
    elevated: boolean;
    failed: number;
    p50: number;
    p90: number;
    requests: number;
    since: string; // ISO timestamp
}

interface Sample { at: number; failed: boolean; ms: number }
interface State { calm: number; latency: Latency | null }

let samples: Array<Sample> = [];

/** Called for every request to e621 */
export function recordRequest(ms: number, failed: boolean): void {
    const now = Date.now();
    samples.push({ at: now, failed, ms });
    samples = samples.filter(sample => sample.at >= now - WINDOW_MS);
}

export async function getLatency(): Promise<Latency | null> {
    const raw = await Redis.get(latencyKey);
    return raw ? JSON.parse(raw) as Latency : null;
}

const percentile = (sorted: Array<number>, p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function duration(from: string): string {
    const minutes = Math.round((Date.now() - Date.parse(from)) / 60_000);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function evaluate(state: State, recent: Array<Sample>): State & { change: "elevated" | "recovered" | null; elevatedAt?: string } {
    if (recent.length < MIN_SAMPLES) return { ...state, change: null };
    const sorted = recent.map(sample => sample.ms).sort((a, b) => a - b);
    const at = new Date().toISOString();
    const latency: Latency = {
        checked_at: at,
        elevated: state.latency?.elevated ?? false,
        failed: recent.filter(sample => sample.failed).length,
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        requests: recent.length,
        since: state.latency?.since ?? at,
    };
    const slow = latency.p50 >= IngesterConfig.latencyAlertMS;
    const calm = slow ? 0 : state.calm + 1;
    if (!latency.elevated && slow) return { calm, latency: { ...latency, elevated: true, since: at }, change: "elevated" };
    if (latency.elevated && calm >= RECOVER_CHECKS) return { calm, latency: { ...latency, elevated: false, since: at }, change: "recovered", elevatedAt: latency.since };
    return { calm, latency, change: null };
}

async function alert(title: string, color: "GREEN" | "RED", latency: Latency, extra: string): Promise<void> {
    const description = `Median ${seconds(latency.p50)}, p90 ${seconds(latency.p90)} over the last 5 minutes (${latency.requests} requests, ${latency.failed} failed).\n${extra}`;
    await logDiscord(title, description, color).catch((err: unknown) => { Debug("ingester:latency", `couldn't post to discord: ${String(err)}`); });
}

async function check(state: State): Promise<State> {
    const next = evaluate(state, samples.filter(sample => sample.at >= Date.now() - WINDOW_MS));
    const { latency } = next;
    if (!latency || latency === state.latency) return next;
    const admin = new URL("/admin", Config.publicURL).href;
    const mode = next.change === null ? null : await getSlowMode();
    if (next.change === "elevated") {
        Debug("ingester:latency", `request times are elevated, median ${latency.p50}ms`);
        await alert("e621 request times are elevated", "RED", latency, mode ? `Slow mode is on (${mode.scale}x).` : `Slow mode can be turned on from ${admin}`);
    } else if (next.change === "recovered") {
        const took = duration(next.elevatedAt!);
        Debug("ingester:latency", `request times recovered after ${took}, median ${latency.p50}ms`);
        await alert("e621 request times have recovered", "GREEN", latency, `They were elevated for ${took}.${mode ? ` Slow mode is still on (${mode.scale}x), it can be turned off from ${admin}` : ""}`);
    }
    await Redis.set(latencyKey, JSON.stringify(latency));
    return next;
}

/** Alerts on discord when e621's median request time goes over LATENCY_ALERT_MS, and when it comes back down */
export async function startLatencyWatch(): Promise<void> {
    let state: State = { calm: 0, latency: await getLatency() };
    setInterval(() => {
        void check(state)
            .then((next) => { state = next; })
            .catch((err: unknown) => { Debug("ingester:latency", `check failed: ${String(err)}`); });
    }, CHECK_MS);
}
