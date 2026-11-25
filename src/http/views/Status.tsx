import { REPOSITORY_URL, type BackfillProgress, type NamedFeed, type StatusData } from "../Status.ts";

import Main from "./layouts/Main.tsx";
import Time from "./partials/Time.tsx";

import type { FeedIncident } from "../../ingester/feedLog.ts";

const STATUS_CLASSES: Record<string, string> = {
    done: "text-success",
    running: "text-info",
    pending: "text-body-secondary",
    waiting: "text-body-secondary",
    failed: "text-danger",
    cancelled: "text-body-secondary",
};

const num = (n: number): string => n.toLocaleString("en-US");
const ms = (value: number | null): string => value === null ? "" : `${num(value)}ms`;
const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

function duration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m`;
    return `${Math.floor(seconds / 86_400)}d ${Math.round(seconds % 86_400 / 3600)}h`;
}

function ago(iso: string | null | undefined): string {
    if (!iso) return "never";
    const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
    return seconds < 0 ? "just now" : `${duration(seconds)} ago`;
}

const since = (iso: string): string => duration(Math.round((Date.now() - Date.parse(iso)) / 1000));

export default function Status({ data }: { data: StatusData }): JSX.Element {
    const { events, requests } = data;
    const backfilling = data.backfill.some(source => source.status !== "done");
    return (
        <Main title="Status" scripts={["pages/status"]} styles={["pages/status"]}>
            <div id="status">
                {data.recovery?.active && <RecoveryNotice recovery={data.recovery} />}
                <h1 class="h3">E621Stream Status</h1>
                {data.ingester.slow_poll_scale !== null && <p class="text-info">e621 is responding slowly, so every feed is polled {data.ingester.slow_poll_scale}x slower for now.</p>}
                {data.latency?.elevated && <p class="text-warning">Requests to e621 have been slow since {ago(data.latency.since)}, the median is {ms(data.latency.p50)}.</p>}
                <p>
                    {data.ingester.idle
                        ? `Nobody's connected, so feeds are polled ${data.ingester.idle_poll_scale}x slower and the backfill gets the spare requests.`
                        : data.gateway.connections === 0
                            ? "Nobody's connected, but there's nothing left to backfill, so feeds are polled at full speed."
                            : `${num(data.gateway.connections)} connection(s), feeds are polled at full speed.`}
                </p>

                <h2 class="h4 mt-4">Events</h2>
                <Stats>
                    <Stat label="per minute (last hour)" value={num(events.per_minute_last_hour)} />
                    <Stat label="last hour" value={num(events.last_hour)} />
                    <Stat label="last 24 hours" value={num(events.last_24h)} />
                    <Stat label="total" value={num(events.total)} sub={data.tracking_since ? `since ${data.tracking_since.slice(0, 10)}` : undefined} />
                    <Stat label="kept for replay" value={num(events.retained)} sub={events.oldest_retained_at ? `back to ${ago(events.oldest_retained_at)}` : undefined} />
                    <Stat label="latest event" value={ago(events.last_event_at)} />
                </Stats>
                <Chart label="events" values={events.per_minute.map(m => m.events)} />

                <h2 class="h4 mt-4">Requests to e621</h2>
                <Stats>
                    <Stat label="per second (last hour)" value={String(requests.per_second_last_hour)} />
                    <Stat label="average time (last hour)" value={ms(requests.avg_ms.last_hour) || "-"} sub={requests.avg_ms.last_24h === null ? undefined : `${ms(requests.avg_ms.last_24h)} over 24 hours`} />
                    <Stat label="last hour" value={num(requests.last_hour)} />
                    <Stat label="last 24 hours" value={num(requests.last_24h)} />
                    <Stat label="failed (last 24 hours)" value={num(requests.failed.last_24h)} sub={`${num(requests.failed.last_hour)} in the last hour`} />
                    <Stat label="rate limited (last 24 hours)" value={num(requests.ratelimited.last_24h)} />
                </Stats>
                <Chart label="requests" values={requests.per_minute.map(m => m.requests)} failed={requests.per_minute.map(m => m.failed)} />
                <Chart label="ms average" values={requests.per_minute.map(m => m.avg_ms ?? 0)} />
                <RequestTables requests={requests} />

                {backfilling && <BackfillSection backfill={data.backfill} />}
                {data.recovery && <RecoverySection recovery={data.recovery} />}
                {data.previous_recoveries.length !== 0 && <PreviousRecoveries recoveries={data.previous_recoveries} />}

                <h2 class="h4 mt-4">Data</h2>
                <p class="text-body-secondary">
                    Every record events are built from. Deleted and hidden records have ids that are never seen, so the highest id is more than what can be stored.
                    Changes show up within the slowest of each model's feeds, which is {data.ingester.idle_poll_scale}x slower while nobody's connected and the backfill is running.
                    Counted {ago(data.data.counted_at)}.
                </p>
                <Table head={["Model", "Stored", "Highest id on e621", "Last checked", "Changes show up"]}>
                    {data.data.models.map(model => (
                        <tr>
                            <td safe>{model.label}</td>
                            <td>{num(model.stored)}</td>
                            <td>{model.newest_id === null ? "" : num(model.newest_id)}</td>
                            <td>{ago(model.last_checked_at)}</td>
                            <td>{model.lag_ms === null ? "" : `within ${duration(Math.round(model.lag_ms / 1000))}`}</td>
                        </tr>
                    ))}
                </Table>

                <h2 class="h4 mt-4">Feeds</h2>
                <Table head={["Feed", "Every", "Last poll", "Events published", "Last failure"]}>
                    {data.feeds.map(feed => <FeedRow feed={feed} />)}
                </Table>

                <h2 class="h4 mt-4">Feed Log</h2>
                <p class="text-body-secondary">Times a feed failed, how long for, and what could have been missed because of it. Skipped ranges are by updated_at, a recovery over them fills them in.</p>
                <FeedLog feeds={data.feeds} log={data.feed_log} />

                <h2 class="h4 mt-4">Event Types</h2>
                <Table head={["Type", "Last hour", "Last 24 hours", "Total"]}>
                    {events.by_type.map(type => (
                        <tr>
                            <td><code safe>{type.type}</code></td>
                            <td>{num(type.last_hour)}</td>
                            <td>{num(type.last_24h)}</td>
                            <td>{num(type.total)}</td>
                        </tr>
                    ))}
                </Table>

                <footer class="mt-4 small text-body-secondary">
                    {data.tracking_since && <>Counting since <Time date={new Date(data.tracking_since)} />. </>}
                    Ingester up since {ago(data.ingester.started_at)}. Updated <Time date={new Date(data.generated_at)} />, refreshes every 15 seconds. <a href="/status.json">JSON</a>
                    <br />
                    <Versions http={data.version} ingester={data.ingester.version} />
                </footer>
            </div>
        </Main>
    );
}

function Stats({ children }: { children: JSX.Element | Array<JSX.Element> }): JSX.Element {
    return <div class="row row-cols-2 row-cols-md-3 row-cols-lg-6 g-2">{children}</div>;
}

function Stat({ label, sub, value }: { label: string; sub?: string; value: string }): JSX.Element {
    return (
        <div class="col">
            <div class="card h-100">
                <div class="card-body p-2">
                    <div class="fs-5 status-value" safe>{value}</div>
                    <div class="small" safe>{label}</div>
                    {sub && <div class="small text-body-secondary" safe>{sub}</div>}
                </div>
            </div>
        </div>
    );
}

// a bar for each minute of the last hour, the failed part of it is red at the bottom
function Chart({ failed, label, values }: { failed?: Array<number>; label: string; values: Array<number> }): JSX.Element {
    const max = Math.max(1, ...values), width = 6, gap = 2, height = 48;
    const scale = (value: number): number => Math.max(value === 0 ? 0 : 1, Math.round(value / max * height));
    return (
        <svg class="status-chart" viewBox={`0 0 ${values.length * (width + gap)} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label} per minute, last hour`}>
            {values.map((value, i) => {
                const bar = scale(value), bad = Math.min(bar, scale(failed?.[i] ?? 0));
                return (
                    <g>
                        <title safe>{`${num(value)} ${label}${failed?.[i] ? `, ${num(failed[i])} failed` : ""}`}</title>
                        <rect x={i * (width + gap)} y={height - bar} width={width} height={bar} />
                        {bad !== 0 && <rect class="failed" x={i * (width + gap)} y={height - bad} width={width} height={bad} />}
                    </g>
                );
            })}
        </svg>
    );
}

function Table({ children, head }: { children: JSX.Element | Array<JSX.Element>; head: Array<string> }): JSX.Element {
    return (
        <div class="table-responsive">
            <table class="table table-sm table-bordered data-table">
                <thead>
                    <tr>{head.map(name => <th scope="col" safe>{name}</th>)}</tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

function Progress({ fraction }: { fraction: number | null | undefined }): JSX.Element {
    if (fraction === null || fraction === undefined) return <></>;
    return (
        <div class="d-flex align-items-center gap-2">
            <div class="progress flex-grow-1" role="progressbar" aria-valuenow={String(Math.round(fraction * 100))} aria-valuemin="0" aria-valuemax="100">
                <div class="progress-bar bg-success" style={`width: ${Math.round(fraction * 100)}%`}></div>
            </div>
            <span class="small">{percent(fraction)}</span>
        </div>
    );
}

function RequestTables({ requests }: { requests: StatusData["requests"] }): JSX.Element {
    const routes = Object.entries(requests.by_route);
    return (
        <>
            <Table head={["From", "Last hour", "Failed", "Avg time", "Last 24 hours", "Failed", "Rate limited", "Avg time"]}>
                {Object.entries(requests.by_role).map(([role, r]) => (
                    <tr>
                        <td safe>{role}</td>
                        <td>{num(r.last_hour.requests)}</td>
                        <td>{num(r.last_hour.failed)}</td>
                        <td>{ms(r.last_hour.avg_ms)}</td>
                        <td>{num(r.last_24h.requests)}</td>
                        <td>{num(r.last_24h.failed)}</td>
                        <td>{num(r.last_24h.ratelimited)}</td>
                        <td>{ms(r.last_24h.avg_ms)}</td>
                    </tr>
                ))}
            </Table>
            {routes.length !== 0 && (
                <Table head={["Sent via", "Last hour", "Failed", "Avg time", "Last 24 hours", "Failed", "Avg time"]}>
                    {routes.map(([route, r]) => (
                        <tr class={r.failing ? "status-failing" : undefined}>
                            <td safe>{route}</td>
                            <td>{num(r.last_hour.requests)}</td>
                            <td>{num(r.last_hour.failed)}</td>
                            <td>{ms(r.last_hour.avg_ms)}</td>
                            <td>{num(r.last_24h.requests)}</td>
                            <td>{num(r.last_24h.failed)}</td>
                            <td>{ms(r.last_24h.avg_ms)}</td>
                        </tr>
                    ))}
                </Table>
            )}
        </>
    );
}

function BackfillSection({ backfill }: { backfill: Array<BackfillProgress> }): JSX.Element {
    return (
        <>
            <h2 class="h4 mt-4">Backfill</h2>
            <p class="text-body-secondary">Storing what was made before the feeds started, so changes to it can be seen.</p>
            <Table head={["Source", "Status", "Progress", "Stored", "Left", ""]}>
                {backfill.map(source => (
                    <tr>
                        <td><code safe>{source.source}</code></td>
                        <td class={STATUS_CLASSES[source.status]} safe>{source.status}</td>
                        <td class="w-25"><Progress fraction={source.progress} /></td>
                        <td>{num(source.stored)}</td>
                        <td>{source.eta_seconds === null ? "" : duration(source.eta_seconds)}</td>
                        <td class={source.error ? "text-danger text-break" : "text-break"} safe>{source.error ?? source.detail ?? ""}</td>
                    </tr>
                ))}
            </Table>
        </>
    );
}

function RecoveryNotice({ recovery }: { recovery: NonNullable<StatusData["recovery"]> }): JSX.Element {
    const finished = recovery.sources.filter(name => ["done", "failed"].includes(recovery.progress[name]?.status ?? "")).length;
    return (
        <div class="alert alert-info">
            We're going back over <Time date={new Date(recovery.from)} /> to <Time date={new Date(recovery.to)} /> for events we missed, they're sent with <code>"recovered": true</code>.
            {" "}{finished} of {recovery.sources.length} source(s) done so far.
        </div>
    );
}

function RecoverySection({ recovery }: { recovery: NonNullable<StatusData["recovery"]> }): JSX.Element {
    const detailed = recovery.sources.some(name => recovery.progress[name]?.error ?? recovery.progress[name]?.detail);
    return (
        <>
            <h2 class="h4 mt-4">Recovery</h2>
            <p>
                {recovery.active ? "Running" : "The last one"}: <Time date={new Date(recovery.from)} /> to <Time date={new Date(recovery.to)} />,{" "}
                <span class={STATUS_CLASSES[recovery.status]} safe>{recovery.status}</span>, {num(recovery.events)} event(s) sent
                {recovery.started_at && `, started ${ago(recovery.started_at)}`}
                {recovery.finished_at && `, finished ${ago(recovery.finished_at)}`}.
                {recovery.error !== null && <> <span class="text-danger" safe>{recovery.error}</span></>}
            </p>
            <p class="text-body-secondary">Going back over a window of time events were missed in, and sending what wasn't sent the first time.</p>
            <Table head={["Source", "Status", "Progress", "Events", ...detailed ? ["Detail"] : []]}>
                {recovery.sources.map((name) => {
                    const progress = recovery.progress[name];
                    return (
                        <tr>
                            <td><code safe>{name}</code></td>
                            <td class={STATUS_CLASSES[progress?.status ?? "pending"]} safe>{progress?.status ?? "pending"}</td>
                            <td class="w-25"><Progress fraction={progress?.fraction} /></td>
                            <td>{num(progress?.events ?? 0)}</td>
                            {detailed && <td class={progress?.error ? "text-danger text-break" : "text-break"} safe>{progress?.error ?? progress?.detail ?? ""}</td>}
                        </tr>
                    );
                })}
            </Table>
        </>
    );
}

function PreviousRecoveries({ recoveries }: { recoveries: StatusData["previous_recoveries"] }): JSX.Element {
    const errors = recoveries.map(recovery => [recovery.error, ...Object.entries(recovery.progress).filter(([, p]) => p.error).map(([name, p]) => `${name}: ${p.error}`)].filter(error => error !== null));
    const anyErrors = errors.some(list => list.length !== 0);
    return (
        <>
            <h3 class="h5 mt-3">Previous Recoveries</h3>
            <Table head={["Window", "Sources", "Status", "Events", "Finished", ...anyErrors ? ["Errors"] : []]}>
                {recoveries.map((recovery, i) => (
                    <tr>
                        <td><Time date={new Date(recovery.from)} /> to <Time date={new Date(recovery.to)} /></td>
                        <td class="text-break" safe>{recovery.sources.join(", ")}</td>
                        <td class={STATUS_CLASSES[recovery.status]} safe>{recovery.status}</td>
                        <td>{num(recovery.events)}</td>
                        <td>{recovery.finished_at ? ago(recovery.finished_at) : ""}</td>
                        {anyErrors && <td class="text-danger text-break">{errors[i]!.map(error => <div safe>{error}</div>)}</td>}
                    </tr>
                ))}
            </Table>
        </>
    );
}

function FeedRow({ feed }: { feed: NamedFeed }): JSX.Element {
    const interval = feed.interval_ms ?? 0;
    // well past when it should have polled again
    const stale = !feed.paused && (!feed.last_ok_at || Date.now() - Date.parse(feed.last_ok_at) > (interval * 5) + 60_000);
    return (
        <tr>
            <td><code safe>{feed.name}</code></td>
            <td>{feed.paused ? <span class="text-warning">paused</span> : duration(Math.round(interval / 1000))}</td>
            <td class={stale ? "text-danger" : undefined}>{ago(feed.last_ok_at)}</td>
            <td>{num(feed.published ?? 0)}</td>
            <td class={feed.error ? "text-danger text-break" : "text-body-secondary"} safe>{feed.error ? `${ago(feed.last_failed_at)}: ${feed.error}` : feed.last_failed_at ? ago(feed.last_failed_at) : ""}</td>
        </tr>
    );
}

function FeedLog({ feeds, log }: { feeds: Array<NamedFeed>; log: Array<FeedIncident> }): JSX.Element {
    // ones still going are only on the feed, they're logged once they end
    const open = feeds.flatMap(feed => feed.outage ? [feed.outage] : []).toSorted((a, b) => b.started_at.localeCompare(a.started_at));
    const incidents = [...open, ...log];
    if (incidents.length === 0) return <p class="text-body-secondary">Nothing yet.</p>;
    return (
        <Table head={["Feed", "Started", "Length", "Failures", "Skipped", "Errors"]}>
            {incidents.map(incident => (
                <tr>
                    <td><code safe>{incident.feed}</code></td>
                    <td><Time date={new Date(incident.started_at)} /></td>
                    <td>
                        {incident.ended_at === null
                            ? <span class="text-danger">ongoing, {since(incident.started_at)}</span>
                            : incident.failures === 0 ? "" : duration(Math.round((incident.duration_ms ?? 0) / 1000))}
                    </td>
                    <td>{num(incident.failures)}</td>
                    <td>
                        {incident.skipped
                            ? <span class="text-danger"><Time date={new Date(incident.skipped.from)} /> to <Time date={new Date(incident.skipped.to)} /></span>
                            : incident.ended_at === null ? "" : "none"}
                    </td>
                    <td class="text-break">
                        {incident.failures === 0 ? "too many changes to catch up on in one poll" : incident.errors.map(error => <div safe>{error}</div>)}
                    </td>
                </tr>
            ))}
        </Table>
    );
}

// commits link to github, anything else is shown as is
function Version({ version }: { version: string }): JSX.Element {
    if (/^[\da-f]{40}$/.test(version)) return <a href={`${REPOSITORY_URL}/commit/${version}`}><code>{version.slice(0, 7)}</code></a>;
    return <code safe>{version}</code>;
}

function Versions({ http, ingester }: { http: string; ingester: string | null }): JSX.Element {
    if (!ingester || ingester === http) return <>Running <Version version={http} />.</>;
    return <>Website running <Version version={http} />, ingester running <Version version={ingester} />.</>;
}
