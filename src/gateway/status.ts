import { listStates, type BackfillState } from "../backfill/state.ts";
import { clientsKey, feedsKey, idleKey, idlePollScale, redisPrefix, streamKey } from "../config.ts";
import { recent, totals, type Counts } from "../metrics.ts";
import { NAV, NAV_CSS, navHTML } from "../nav.ts";
import redis from "../redis.ts";

import { hubStats } from "./hub.ts";
import { sessions } from "./session.ts";

import type { FeedHealth } from "../ingester/index.ts";

const sum = (counts: Counts, prefix: string): number => Object.entries(counts).reduce((total, [field, n]) => field === prefix || field.startsWith(`${prefix}.`) ? total + n : total, 0);
const add = (list: Array<Counts>): Counts => {
    const out: Counts = {};
    for (const counts of list) for (const [field, n] of Object.entries(counts)) out[field] = (out[field] ?? 0) + n;
    return out;
};
const eventsOf = (counts: Counts): number => counts.events ?? 0;
const requestsOf = (counts: Counts): number => sum(counts, "requests") - (counts["requests.backfill"] ?? 0);
const avgMs = (ms: number, requests: number): number | null => requests === 0 ? null : Math.round(ms / requests);
const averageOf = (counts: Counts): number | null => avgMs(sum(counts, "request_ms"), requestsOf(counts));

interface Backfill extends BackfillState {
    eta_seconds: number | null;
    progress: number | null;
}

function backfillProgress(state: BackfillState): Backfill {
    let progress: number | null = null;
    if (state.status === "done") progress = 1;
    else if (state.ceiling && state.cursor !== null) progress = state.kind === "crawl" ? (state.ceiling - Math.min(state.cursor, state.ceiling)) / state.ceiling : state.cursor / state.ceiling;
    let eta: number | null = null;
    if (state.status === "running" && progress && progress < 1 && state.started_at) {
        const elapsed = (Date.now() - new Date(state.started_at).getTime()) / 1000;
        eta = Math.round(elapsed / progress * (1 - progress));
    }
    return { ...state, progress, eta_seconds: eta };
}

async function build(): Promise<Record<string, unknown>> {
    const [minutes, hours, allTime, length, oldest, startedAt, feeds, backfill, clients, idle] = await Promise.all([
        recent("minute", 60),
        recent("hour", 24),
        totals(),
        redis.send("XLEN", [streamKey]) as Promise<number>,
        redis.send("XRANGE", [streamKey, "-", "+", "COUNT", "1"]) as Promise<Array<[string, Array<string>]>>,
        redis.get(`${redisPrefix}:ingester:started_at`),
        redis.send("HGETALL", [feedsKey]) as Promise<Record<string, string> | null>,
        listStates().then(states => states.map(backfillProgress)).catch((err: unknown) => ({ error: String(err) })),
        redis.send("HVALS", [clientsKey]).then(counts => (counts as Array<string>).reduce((total, n) => total + Number(n), 0)),
        redis.get(idleKey),
    ]);
    const hour = add(minutes.map(m => m.counts)), day = add(hours.map(h => h.counts));
    const byType = Object.entries(day).filter(([field]) => field.startsWith("events.")).map(([field, n]) => ({ type: field.slice(7), count: n })).sort((a, b) => b.count - a.count);
    const roles = [...new Set(Object.keys(allTime).filter(field => field.startsWith("requests.")).map(field => field.slice(9)))].sort();
    const rate = (counts: Counts, role: string): Record<string, number | null> => ({
        requests: counts[`requests.${role}`] ?? 0,
        failed: counts[`failed.${role}`] ?? 0,
        ratelimited: counts[`ratelimited.${role}`] ?? 0,
        avg_ms: counts[`request_ms.${role}`] === undefined ? null : avgMs(counts[`request_ms.${role}`]!, counts[`requests.${role}`] ?? 0),
    });
    return {
        generated_at: new Date().toISOString(),
        ingester: { started_at: startedAt, idle: idle === "true", idle_poll_scale: idlePollScale, clients },
        requests: {
            per_second_last_hour: Math.round(requestsOf(hour) / 3600 * 100) / 100,
            avg_ms: { last_hour: averageOf(hour), last_24h: averageOf(day), total: averageOf(allTime) },
            last_hour: requestsOf(hour),
            last_24h: requestsOf(day),
            total: requestsOf(allTime),
            failed: { last_hour: sum(hour, "failed"), last_24h: sum(day, "failed"), total: sum(allTime, "failed") },
            ratelimited: { last_hour: sum(hour, "ratelimited"), last_24h: sum(day, "ratelimited"), total: sum(allTime, "ratelimited") },
            by_role: Object.fromEntries(roles.map(role => [role, { last_hour: rate(hour, role), last_24h: rate(day, role), total: rate(allTime, role) }])),
            per_minute: minutes.map(m => ({ at: new Date(m.at).toISOString(), requests: requestsOf(m.counts), failed: sum(m.counts, "failed"), avg_ms: averageOf(m.counts) })),
        },
        events: {
            per_minute_last_hour: Math.round(eventsOf(hour) / 60 * 10) / 10,
            last_hour: eventsOf(hour),
            last_24h: eventsOf(day),
            total: eventsOf(allTime),
            retained: length,
            oldest_retained_at: oldest[0] ? new Date(Number(oldest[0][0].split("-")[0])).toISOString() : null,
            last_event_at: hubStats.lastEventAt,
            by_type_last_24h: byType,
            per_minute: minutes.map(m => ({ at: new Date(m.at).toISOString(), events: eventsOf(m.counts) })),
        },
        gateway: { connections: sessions.size, events_received: hubStats.received },
        feeds: Object.entries(feeds ?? {}).map(([name, health]) => ({ name, ...JSON.parse(health) as FeedHealth })).sort((a, b) => a.name.localeCompare(b.name)),
        backfill,
    };
}

let cache: { at: number; data: Promise<Record<string, unknown>> } | null = null;
export function status(): Promise<Record<string, unknown>> {
    if (!cache || Date.now() - cache.at > 10_000) {
        cache = { at: Date.now(), data: build() };
        cache.data.catch(() => { cache = null; });
    }
    return cache.data;
}

const esc = (value: number | string | null | undefined): string => String(value ?? "").replaceAll(/[&<>"']/g, char => `&#${char.codePointAt(0)};`);
const num = (n: number): string => n.toLocaleString("en-US");

function ago(iso: string | null | undefined): string {
    if (!iso) return "never";
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    return seconds < 0 ? "just now" : `${duration(seconds)} ago`;
}

function duration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m`;
    return `${Math.floor(seconds / 86_400)}d ${Math.round(seconds % 86_400 / 3600)}h`;
}

function chart(values: Array<number>, label: string, highlight?: Array<number>): string {
    const max = Math.max(1, ...values), w = 6, gap = 2, h = 48;
    const bars = values.map((v, i) => {
        const height = Math.max(v === 0 ? 0 : 1, Math.round(v / max * h));
        const bad = highlight?.[i] ? ` class="bad"` : "";
        return `<rect${bad} x="${i * (w + gap)}" y="${h - height}" width="${w}" height="${height}"><title>${num(v)} ${label}${highlight?.[i] ? `, ${num(highlight[i])} failed` : ""}</title></rect>`;
    }).join("");
    return `<svg class="chart" viewBox="0 0 ${values.length * (w + gap)} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)} per minute, last hour">${bars}</svg>`;
}

const STATUS_CLASS: Record<string, string> = { done: "ok", running: "run", failed: "bad", waiting: "dim", pending: "dim" };

export async function statusPage(): Promise<string> {
    const data = await status() as {
        backfill: Array<Backfill> | { error: string };
        events: { by_type_last_24h: Array<{ count: number; type: string }>; last_24h: number; last_event_at: string | null; last_hour: number; oldest_retained_at: string | null; per_minute: Array<{ events: number }>; per_minute_last_hour: number; retained: number; total: number };
        feeds: Array<FeedHealth & { name: string }>;
        gateway: { connections: number };
        generated_at: string;
        ingester: { clients: number; idle: boolean; idle_poll_scale: number; started_at: string | null };
        requests: { avg_ms: Record<string, number | null>; by_role: Record<string, { last_24h: Record<string, number | null>; last_hour: Record<string, number | null> }>; failed: Counts; last_24h: number; last_hour: number; per_minute: Array<{ avg_ms: number | null; failed: number; requests: number }>; per_second_last_hour: number; ratelimited: Counts; total: number };
    };
    const { backfill, events, feeds, requests } = data;
    const stat = (label: string, value: string, sub = ""): string => `<div class="stat"><div class="value">${value}</div><div class="label">${esc(label)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
    const backfillRows = Array.isArray(backfill)
        ? backfill.sort((a, b) => a.source.localeCompare(b.source)).map(b => `<tr>
            <td>${esc(b.source)}</td><td>${esc(b.kind)}</td><td class="${STATUS_CLASS[b.status] ?? ""}">${esc(b.status)}</td>
            <td><div class="bar"><div style="width:${Math.round((b.progress ?? 0) * 100)}%"></div></div>${b.progress === null ? "" : `${(b.progress * 100).toFixed(1)}%`}</td>
            <td class="n">${num(b.stored)}</td><td>${b.eta_seconds === null ? "" : duration(b.eta_seconds)}</td>
            <td class="detail">${esc(b.error ?? b.detail ?? "")}</td></tr>`).join("")
        : `<tr><td colspan="7" class="bad">${esc(backfill.error)}</td></tr>`;
    const feedRows = feeds.map((f) => {
        const stale = f.last_ok_at && Date.now() - new Date(f.last_ok_at).getTime() > f.interval_ms * 5 + 60_000;
        return `<tr><td>${esc(f.name)}</td><td>${duration(Math.round(f.interval_ms / 1000))}</td><td class="${stale || !f.last_ok_at ? "bad" : ""}">${ago(f.last_ok_at)}</td>
            <td class="n">${num(f.published)}</td><td class="${f.error ? "bad" : "dim"}">${f.error ? `${ago(f.last_failed_at)}: ${esc(f.error)}` : f.last_failed_at ? ago(f.last_failed_at) : ""}</td></tr>`;
    }).join("");
    const ms = (value: number | null | undefined): string => value === null || value === undefined ? "" : `${num(value)}ms`;
    const roleRows = Object.entries(requests.by_role).map(([role, r]) => `<tr><td>${esc(role)}</td>
        <td class="n">${num(r.last_hour.requests ?? 0)}</td><td class="n">${num(r.last_hour.failed ?? 0)}</td><td class="n">${ms(r.last_hour.avg_ms)}</td>
        <td class="n">${num(r.last_24h.requests ?? 0)}</td><td class="n">${num(r.last_24h.failed ?? 0)}</td><td class="n">${num(r.last_24h.ratelimited ?? 0)}</td><td class="n">${ms(r.last_24h.avg_ms)}</td></tr>`).join("");
    const typeRows = events.by_type_last_24h.map(t => `<tr><td>${esc(t.type)}</td><td class="n">${num(t.count)}</td></tr>`).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Status - E621Stream</title>
<style>
:root { --bg: #1c1c21; --surface: #242424; --border: #3e4346; --text: #bfbfbf; --heading: #fff; --link: #a9cbea; --ok: #8fd18f; --bad: #e69999; --run: #a9cbea; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: sans-serif; line-height: 1.5; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
a { color: var(--link); }
h1, h2 { color: var(--heading); }
h2 { margin-top: 36px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.stat { background: var(--surface); border-radius: 4px; padding: 12px; }
.stat .value { color: var(--heading); font-size: 1.5em; font-variant-numeric: tabular-nums; }
.stat .label { font-size: 0.85em; }
.stat .sub { font-size: 0.8em; opacity: 0.7; }
.chart { width: 100%; height: 64px; margin-top: 12px; fill: var(--run); }
.chart .bad { fill: var(--bad); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 0.9em; }
th, td { border: 1px solid var(--border); padding: 5px 8px; text-align: left; vertical-align: top; }
th { color: var(--heading); background: var(--surface); }
td.n { text-align: right; font-variant-numeric: tabular-nums; }
td.detail { max-width: 360px; overflow-wrap: anywhere; }
.ok { color: var(--ok); } .bad { color: var(--bad); } .run { color: var(--run); } .dim { opacity: 0.6; }
.bar { display: inline-block; width: 80px; height: 8px; background: var(--border); border-radius: 4px; margin-right: 6px; vertical-align: middle; overflow: hidden; }
.bar div { height: 100%; background: var(--ok); }
footer { margin-top: 32px; font-size: 0.85em; opacity: 0.7; }
${NAV_CSS}
</style>
</head>
<body>
${navHTML(NAV, "/status")}
<main>
<h1>E621Stream status</h1>
<p>${data.ingester.idle ? `Nobody's connected, so feeds are polled ${data.ingester.idle_poll_scale}x slower and the backfill gets the spare requests.` : `${num(data.ingester.clients)} client(s) connected, feeds are polled at full speed.`}</p>

<h2>Events</h2>
<div class="stats">
${stat("per minute (last hour)", num(events.per_minute_last_hour))}
${stat("last hour", num(events.last_hour))}
${stat("last 24 hours", num(events.last_24h))}
${stat("total", num(events.total))}
${stat("kept for replay", num(events.retained), events.oldest_retained_at ? `back to ${ago(events.oldest_retained_at)}` : "")}
${stat("latest event", ago(events.last_event_at))}
</div>
${chart(events.per_minute.map(m => m.events), "events")}

<h2>Requests to e621</h2>
<div class="stats">
${stat("per second (last hour)", String(requests.per_second_last_hour))}
${stat("average time (last hour)", ms(requests.avg_ms.last_hour) || "-", requests.avg_ms.last_24h === null ? "" : `${ms(requests.avg_ms.last_24h)} over 24 hours`)}
${stat("last hour", num(requests.last_hour))}
${stat("last 24 hours", num(requests.last_24h))}
${stat("total", num(requests.total))}
${stat("failed (last 24 hours)", num(requests.failed.last_24h ?? 0), `${num(requests.failed.last_hour ?? 0)} in the last hour`)}
${stat("rate limited (last 24 hours)", num(requests.ratelimited.last_24h ?? 0))}
</div>
${chart(requests.per_minute.map(m => m.requests), "requests", requests.per_minute.map(m => m.failed))}
${chart(requests.per_minute.map(m => m.avg_ms ?? 0), "ms average")}
<div class="table-wrap"><table>
<tr><th>from</th><th>last hour</th><th>failed</th><th>avg time</th><th>last 24 hours</th><th>failed</th><th>rate limited</th><th>avg time</th></tr>
${roleRows}
</table></div>

<h2>Backfill</h2>
<div class="table-wrap"><table>
<tr><th>source</th><th>from</th><th>status</th><th>progress</th><th>stored</th><th>left</th><th></th></tr>
${backfillRows}
</table></div>

<h2>Feeds</h2>
<div class="table-wrap"><table>
<tr><th>feed</th><th>every</th><th>last poll</th><th>events since start</th><th>last failure</th></tr>
${feedRows}
</table></div>

<h2>Event types (last 24 hours)</h2>
<div class="table-wrap"><table>
<tr><th>type</th><th>events</th></tr>
${typeRows}
</table></div>

<footer>${num(data.gateway.connections)} connection(s) to this gateway. Ingester up since ${ago(data.ingester.started_at)}. Updated ${esc(new Date(data.generated_at).toUTCString())}, refreshes every 15 seconds. <a href="/status.json">JSON</a></footer>
</main>
</body>
</html>`;
}
