import { feedLogKey } from "../config.ts";
import redis from "../redis.ts";

const MAX_ENTRIES = 500;
const MAX_ERRORS = 5;

export interface PollResult {
    published: number;
    skipped?: { from: number; to: number };
}

export interface FeedIncident {
    duration_ms: number | null;
    ended_at: string | null;
    errors: Array<string>;
    failures: number;
    feed: string;
    skipped: { from: string; to: string } | null;
    started_at: string;
}

const skippedRange = (result: PollResult): FeedIncident["skipped"] => result.skipped ? { from: new Date(result.skipped.from).toISOString(), to: new Date(result.skipped.to).toISOString() } : null;

async function log(incident: FeedIncident): Promise<void> {
    await redis.send("LPUSH", [feedLogKey, JSON.stringify(incident)]);
    await redis.send("LTRIM", [feedLogKey, "0", String(MAX_ENTRIES - 1)]);
}

export function failed(feed: string, open: FeedIncident | null, err: unknown): FeedIncident {
    const incident = open ?? { feed, started_at: new Date().toISOString(), ended_at: null, duration_ms: null, failures: 0, errors: [], skipped: null };
    incident.failures++;
    const error = String(err);
    incident.errors = [...incident.errors.filter(e => e !== error), error].slice(-MAX_ERRORS);
    return incident;
}

export async function succeeded(feed: string, open: FeedIncident | null, result: PollResult): Promise<void> {
    const now = new Date();
    if (open) {
        await log({ ...open, ended_at: now.toISOString(), duration_ms: now.getTime() - Date.parse(open.started_at), skipped: skippedRange(result) });
    } else if (result.skipped) {
        await log({ feed, started_at: now.toISOString(), ended_at: now.toISOString(), duration_ms: 0, failures: 0, errors: [], skipped: skippedRange(result) });
    }
}

export async function getLog(limit = 100): Promise<Array<FeedIncident>> {
    const entries = await redis.send("LRANGE", [feedLogKey, "0", String(limit - 1)]) as Array<string>;
    return entries.map(entry => JSON.parse(entry) as FeedIncident);
}
