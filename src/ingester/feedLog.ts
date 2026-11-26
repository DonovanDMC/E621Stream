import Config from "../config/Config.ts";
import Redis from "../db/Redis.ts";

const feedLogKey = `${Config.redisPrefix}feeds:log`;
const MAX_ENTRIES = 500;
const MAX_ERRORS = 5;

export interface PollResult {
    published: number;
    /** When a feed fell too far behind and jumped ahead */
    skipped?: { from: number; to: number };
}

export interface FeedIncident {
    duration_ms: number | null;
    ended_at: string | null; // ISO timestamp
    errors: Array<string>;
    failures: number;
    feed: string;
    skipped: { from: string; to: string } | null;
    started_at: string; // ISO timestamp
}

function skippedRange(result: PollResult): FeedIncident["skipped"] {
    if (!result.skipped) return null;
    return { from: new Date(result.skipped.from).toISOString(), to: new Date(result.skipped.to).toISOString() };
}

async function log(incident: FeedIncident): Promise<void> {
    await Redis.lpush(feedLogKey, JSON.stringify(incident));
    await Redis.ltrim(feedLogKey, 0, MAX_ENTRIES - 1);
}

/** Opens an incident, or adds to the one that's already open */
export function failed(feed: string, open: FeedIncident | null, err: unknown): FeedIncident {
    const incident = open ?? { feed, started_at: new Date().toISOString(), ended_at: null, duration_ms: null, failures: 0, errors: [], skipped: null };
    incident.failures++;
    const error = String(err);
    // only the latest few distinct errors are kept
    incident.errors = [...incident.errors.filter(e => e !== error), error].slice(-MAX_ERRORS);
    return incident;
}

/** Closes the open incident, a skip is logged even without one */
export async function succeeded(feed: string, open: FeedIncident | null, result: PollResult): Promise<void> {
    const now = new Date();
    if (open) await log({ ...open, ended_at: now.toISOString(), duration_ms: now.getTime() - Date.parse(open.started_at), skipped: skippedRange(result) });
    else if (result.skipped) await log({ feed, started_at: now.toISOString(), ended_at: now.toISOString(), duration_ms: 0, failures: 0, errors: [], skipped: skippedRange(result) });
}

export async function getFeedLog(limit = 100): Promise<Array<FeedIncident>> {
    const entries = await Redis.lrange(feedLogKey, 0, limit - 1);
    return entries.map(entry => JSON.parse(entry) as FeedIncident);
}
