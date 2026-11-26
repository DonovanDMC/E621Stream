import pkg from "../../package.json";
import Config from "../config/Config.ts";
import IngesterConfig from "../config/IngesterConfig.ts";
import Backfill from "../db/models/Backfill.ts";
import Redis, { type StreamEntry } from "../db/Redis.ts";
import { latestEvent, streamKey } from "../gateway/events.ts";
import { getRecovery, getRecoveryHistory, isActive, type Recovery } from "../gateway/recovery.ts";
import { getSlowMode } from "../gateway/slowMode.ts";
import { getDataCounts } from "../ingester/data.ts";
import { getFeedLog, type FeedIncident } from "../ingester/feedLog.ts";
import { getFeedHealth, type FeedHealth } from "../ingester/health.ts";
import { getLatency, type Latency } from "../util/latency.ts";
import { recent, totals, trackingSince, type Counts } from "../util/metrics.ts";
import { getRouteStates } from "../util/Route.ts";

const cursorKey = `${Config.redisPrefix}cursors`;
// written by gateway/presence.ts, a count of sessions for each gateway
const clientsKey = `${Config.redisPrefix}clients`;

/** Across every gateway */
export async function connectionCount(): Promise<number> {
    return Object.values(await Redis.hgetall(clientsKey)).reduce((total, n) => total + Number(n), 0);
}
const CACHE_MS = 10_000;

export const REPOSITORY_URL = pkg.repository.url;

const MODELS = [
    { resource: "post", label: "Posts", newest: "posts:max_id", feeds: ["posts"] },
    { resource: "comment", label: "Comments", newest: "comments", feeds: ["comments", "comment_updates"] },
    { resource: "forum_post", label: "Forum posts", newest: "forum_posts", feeds: ["forum_posts", "forum_post_updates"] },
    { resource: "forum_topic", label: "Forum topics", newest: "forum_topics", feeds: ["forum_topics", "forum_topic_updates"] },
    { resource: "post_set", label: "Post sets", newest: "post_sets", feeds: ["post_sets", "post_set_updates"] },
    { resource: "post_flag", label: "Post flags", newest: "post_flags", feeds: ["post_flags", "post_flag_updates"] },
    { resource: "post_replacement", label: "Post replacements", newest: "post_replacements", feeds: ["post_replacements", "post_replacement_updates"] },
    { resource: "takedown", label: "Takedowns", newest: "takedowns", feeds: ["takedowns", "takedown_updates"] },
    { resource: "news_update", label: "News updates", newest: "news_updates", feeds: ["news_updates", "news_update_updates"] },
    { resource: "tag_alias", label: "Tag aliases", newest: "tag_aliases", feeds: ["tag_aliases", "tag_alias_updates"] },
    { resource: "tag_implication", label: "Tag implications", newest: "tag_implications", feeds: ["tag_implications", "tag_implication_updates"] },
    { resource: "bulk_update_request", label: "Bulk update requests", newest: "bulk_update_requests", feeds: ["bulk_update_requests", "bulk_update_request_updates"] },
    { resource: "help_page", label: "Help pages", newest: "help_pages:max_id", feeds: ["help_pages"] },
    { resource: "upload_url_rule", label: "Upload url rules", newest: "upload_url_rules:max_id", feeds: ["upload_url_rules"] },
    { resource: "upload_whitelist", label: "Upload whitelists", newest: "upload_whitelists:max_id", feeds: ["upload_whitelists"] },
    { resource: "note", label: "Notes", newest: "notes", feeds: ["notes", "note_versions"] },
    { resource: "pool", label: "Pools", newest: "pools", feeds: ["pools", "pool_versions"] },
    { resource: "wiki_page", label: "Wiki pages", newest: "wiki_pages", feeds: ["wiki_pages", "wiki_page_versions"] },
    { resource: "artist", label: "Artists", newest: "artists", feeds: ["artists", "artist_versions"] },
    { resource: "artist_url", label: "Artist urls", newest: "artist_urls", feeds: ["artist_urls"] },
    { resource: "tag", label: "Tags", newest: "tags", feeds: ["tags", "tag_type_versions"] },
    { resource: "avoid_posting", label: "Avoid posting entries", newest: "avoid_postings", feeds: ["avoid_postings", "avoid_posting_versions"] },
    { resource: "user_feedback", label: "User feedback", newest: "user_feedbacks", feeds: ["user_feedbacks", "mod_actions"] },
    { resource: "ban", label: "Bans", newest: "bans", feeds: ["bans", "mod_actions"] },
    { resource: "blip", label: "Blips", newest: "blips", feeds: ["blips"] },
    { resource: "user", label: "Users", newest: "users", feeds: ["users", "mod_actions"] },
    { resource: "mod_action", label: "Mod actions", newest: "mod_actions", feeds: ["mod_actions"] },
];

export interface Model {
    label: string;
    /** How long a change can take to show up, the slowest of its feeds */
    lag_ms: number | null;
    last_checked_at: string | null;
    newest_id: number | null;
    resource: string;
    stored: number;
}

export interface BackfillProgress {
    detail: string | null;
    error: string | null;
    eta_seconds: number | null;
    progress: number | null;
    source: string;
    status: Backfill["status"];
    stored: number;
}

export type NamedFeed = Partial<FeedHealth> & { name: string };
export interface Rates { avg_ms: number | null; failed: number; ratelimited: number; requests: number }
export interface RouteRates { avg_ms: number | null; failed: number; requests: number }
export interface Totals { last_24h: number; last_hour: number; total: number }

export interface StatusData {
    backfill: Array<BackfillProgress>;
    data: { counted_at: string | null; models: Array<Model> };
    events: {
        by_type: Array<Totals & { type: string }>;
        last_event_at: string | null;
        oldest_retained_at: string | null;
        per_minute: Array<{ at: string; events: number }>;
        per_minute_last_hour: number;
        retained: number;
    } & Totals;
    feed_log: Array<FeedIncident>;
    feeds: Array<NamedFeed>;
    gateway: { connections: number };
    generated_at: string;
    ingester: { idle: boolean; idle_poll_scale: number; slow_poll_scale: number | null; started_at: string | null; version: string | null };
    latency: Latency | null;
    previous_recoveries: Array<Omit<Recovery, "requested_by">>;
    recovery: (Omit<Recovery, "requested_by"> & { active: boolean }) | null;
    requests: {
        avg_ms: { [K in keyof Totals]: number | null };
        by_role: Record<string, { last_24h: Rates; last_hour: Rates }>;
        /** failing is whether any service's last request through it failed */
        by_route: Record<string, { failing: boolean; last_24h: RouteRates; last_hour: RouteRates }>;
        failed: Totals;
        per_minute: Array<{ at: string; avg_ms: number | null; failed: number; requests: number }>;
        per_second_last_hour: number;
        ratelimited: Totals;
    } & Totals;
    tracking_since: string | null;
    version: string;
}

const sum = (counts: Counts, prefix: string): number => Object.entries(counts).reduce((total, [field, n]) => field === prefix || field.startsWith(`${prefix}.`) ? total + n : total, 0);
function add(list: Array<Counts>): Counts {
    const out: Counts = {};
    for (const counts of list) for (const [field, n] of Object.entries(counts)) out[field] = (out[field] ?? 0) + n;
    return out;
}
const eventsOf = (counts: Counts): number => counts.events ?? 0;
// backfill requests are counted twice, once as the ingester's and once as the backfill's
const requestsOf = (counts: Counts): number => sum(counts, "requests") - (counts["requests.backfill"] ?? 0);
const avgMs = (ms: number, requests: number): number | null => requests === 0 ? null : Math.round(ms / requests);
const averageOf = (counts: Counts): number | null => avgMs(sum(counts, "request_ms"), requestsOf(counts));
const totalsOf = <T>(fn: (counts: Counts) => T, hour: Counts, day: Counts, all: Counts): { last_24h: T; last_hour: T; total: T } => ({ last_hour: fn(hour), last_24h: fn(day), total: fn(all) });

function rates(counts: Counts, role: string): Rates {
    const requests = counts[`requests.${role}`] ?? 0;
    return {
        requests,
        failed: counts[`failed.${role}`] ?? 0,
        ratelimited: counts[`ratelimited.${role}`] ?? 0,
        avg_ms: avgMs(counts[`request_ms.${role}`] ?? 0, requests),
    };
}

function models(stored: Record<string, { stored: number }>, cursors: Record<string, string>, feeds: Array<NamedFeed>): Array<Model> {
    return MODELS.map(({ feeds: names, label, newest, resource }) => {
        const health = names.map(name => feeds.find(feed => feed.name === name)).filter(feed => feed !== undefined);
        const checked = health.map(feed => feed.last_ok_at ?? null);
        return {
            resource,
            label,
            stored: stored[resource]?.stored ?? 0,
            newest_id: cursors[newest] === undefined ? null : Number(cursors[newest]),
            // the oldest of its feeds' last polls, so it's when everything was last looked at
            last_checked_at: checked.length === 0 || checked.includes(null) ? null : checked.toSorted()[0]!,
            lag_ms: health.length === 0 ? null : Math.max(...health.map(feed => feed.interval_ms ?? 0)),
        };
    });
}

function backfillProgress(state: Backfill): BackfillProgress {
    let progress: number | null = null;
    if (state.status === "done") progress = 1;
    // cursor is how many ids are left
    else if (state.ceiling && state.cursor !== null) progress = (state.ceiling - Math.min(state.cursor, state.ceiling)) / state.ceiling;
    let eta: number | null = null;
    if (state.status === "running" && progress && progress < 1 && state.started_at) {
        const elapsed = (Date.now() - new Date(state.started_at).getTime()) / 1000;
        eta = Math.round(elapsed / progress * (1 - progress));
    }
    return { source: state.source, status: state.status, stored: state.stored, detail: state.detail, error: state.error, progress, eta_seconds: eta };
}

function hidePerson(recovery: Recovery): Omit<Recovery, "requested_by"> {
    const copy: Partial<Recovery> = { ...recovery };
    delete copy.requested_by;
    return copy as Omit<Recovery, "requested_by">;
}

async function build(): Promise<StatusData> {
    const [minutes, hours, allTime, retained, oldest, lastEvent, startedAt, ingesterVersion, idle, health, feedLog, backfill, clients, counts, cursors, since, recovery, history, slow, latency, routeStates] = await Promise.all([
        recent("minute", 60),
        recent("hour", 24),
        totals(),
        Redis.send("XLEN", [streamKey]) as Promise<number>,
        Redis.send("XRANGE", [streamKey, "-", "+", "COUNT", "1"]) as Promise<Array<StreamEntry>>,
        latestEvent().then(event => event?.time ?? null),
        Redis.get(`${Config.redisPrefix}ingester:started_at`),
        Redis.get(`${Config.redisPrefix}ingester:version`),
        Redis.get(`${Config.redisPrefix}ingester:idle`),
        getFeedHealth(),
        getFeedLog(),
        Backfill.all(),
        connectionCount(),
        getDataCounts(),
        Redis.hgetall(cursorKey),
        trackingSince(),
        getRecovery(),
        getRecoveryHistory(),
        getSlowMode(),
        getLatency(),
        getRouteStates(),
    ]);
    const feeds = Object.entries(health).map(([name, feed]) => ({ name, ...feed })).toSorted((a, b) => a.name.localeCompare(b.name));
    const hour = add(minutes.map(m => m.counts)), day = add(hours.map(h => h.counts));
    const types = Object.keys(allTime).filter(field => field.startsWith("events.") && field !== "events.recovered").map(field => field.slice(7));
    const roles = [...new Set(Object.keys(allTime).filter(field => field.startsWith("requests.")).map(field => field.slice(9)))].toSorted();
    const routes = [...new Set(Object.keys(day).filter(field => field.startsWith("route.")).map(field => field.slice(6)))].toSorted();
    const route = (counts: Counts, name: string): RouteRates => ({ requests: counts[`route.${name}`] ?? 0, failed: counts[`routefailed.${name}`] ?? 0, avg_ms: avgMs(counts[`requestroute_ms.${name}`] ?? 0, counts[`route.${name}`] ?? 0) });

    return {
        generated_at: new Date().toISOString(),
        tracking_since: since,
        version: Config.version,
        ingester: { started_at: startedAt, version: ingesterVersion, idle: idle === "true", idle_poll_scale: IngesterConfig.idlePollScale, slow_poll_scale: slow?.scale ?? null },
        gateway: { connections: clients },
        latency,
        requests: {
            ...totalsOf(requestsOf, hour, day, allTime),
            per_second_last_hour: Math.round(requestsOf(hour) / 3600 * 100) / 100,
            avg_ms: totalsOf(averageOf, hour, day, allTime),
            failed: totalsOf(counts => sum(counts, "failed"), hour, day, allTime),
            ratelimited: totalsOf(counts => sum(counts, "ratelimited"), hour, day, allTime),
            by_role: Object.fromEntries(roles.map(role => [role, { last_hour: rates(hour, role), last_24h: rates(day, role) }])),
            by_route: Object.fromEntries(routes.map(name => [name, {
                failing: Object.entries(routeStates).some(([key, state]) => key.endsWith(`:${name}`) && state.failing),
                last_hour: route(hour, name),
                last_24h: route(day, name),
            }])),
            per_minute: minutes.map(m => ({ at: new Date(m.at).toISOString(), requests: requestsOf(m.counts), failed: sum(m.counts, "failed"), avg_ms: averageOf(m.counts) })),
        },
        events: {
            ...totalsOf(eventsOf, hour, day, allTime),
            per_minute_last_hour: Math.round(eventsOf(hour) / 60 * 10) / 10,
            retained,
            // stream ids start with the time they were added
            oldest_retained_at: oldest[0] ? new Date(Number(oldest[0][0].split("-")[0])).toISOString() : null,
            last_event_at: lastEvent,
            by_type: types.map(type => ({ type, last_hour: hour[`events.${type}`] ?? 0, last_24h: day[`events.${type}`] ?? 0, total: allTime[`events.${type}`] ?? 0 })).toSorted((a, b) => b.total - a.total || a.type.localeCompare(b.type)),
            per_minute: minutes.map(m => ({ at: new Date(m.at).toISOString(), events: eventsOf(m.counts) })),
        },
        feeds,
        feed_log: feedLog,
        backfill: backfill.map(backfillProgress).toSorted((a, b) => a.source.localeCompare(b.source)),
        // who asked for it is only shown to admins
        recovery: recovery ? { ...hidePerson(recovery), active: isActive(recovery) } : null,
        previous_recoveries: history.map(hidePerson),
        data: { counted_at: counts?.computed_at ?? null, models: models(counts?.resources ?? {}, cursors, feeds) },
    };
}

let cache: { at: number; data: Promise<StatusData> } | null = null;
/** Built at most every 10 seconds, it's a lot of redis calls */
export async function getStatus(): Promise<StatusData> {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
        cache = { at: Date.now(), data: build() };
        cache.data.catch(() => { cache = null; });
    }
    return cache.data;
}
