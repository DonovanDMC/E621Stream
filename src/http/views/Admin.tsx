import GatewayConfig from "../../config/GatewayConfig.ts";
import IngesterConfig from "../../config/IngesterConfig.ts";
import { isActive, type Recovery, type RecoveryStatus } from "../../gateway/recovery.ts";
import { RECOVERABLE } from "../../ingester/recovery.ts";
import { FEED_SOURCES } from "../../ingester/sources.ts";
import { MESSAGE_LIMIT_MAX, MESSAGE_LIMIT_MIN, SLOW_MODE_DEFAULT_SCALE, SLOW_MODE_MAX_SCALE, SLOW_MODE_MIN_SCALE } from "../../util/Constants.ts";

import Main from "./layouts/Main.tsx";
import FormButton from "./partials/FormButton.tsx";
import Time from "./partials/Time.tsx";

import type User from "../../db/models/User.ts";
import type { SlowMode } from "../../gateway/slowMode.ts";
import type { FeedControl } from "../../ingester/control.ts";
import type { FeedHealth } from "../../ingester/health.ts";

export interface AdminProps {
    feedControls: Record<string, FeedControl>;
    feedHealth: Record<string, Partial<FeedHealth>>;
    /** Users whose message limit isn't the default */
    limited: Array<User>;
    /** From oauth links, so not everyone has one */
    names: Map<number, string>;
    recovery: Recovery | null;
    slowMode: SlowMode | null;
    /** Admins & owners */
    staff: Array<User>;
    viewer: User;
}

const RECOVERY_CLASSES = {
    pending: "text-info",
    running: "text-info",
    done: "text-success",
    failed: "text-danger",
    cancelled: "text-body-secondary",
} satisfies Record<RecoveryStatus, string>;

export default function Admin({ feedControls, feedHealth, limited, names, recovery, slowMode, staff, viewer }: AdminProps): JSX.Element {
    return (
        <Main title="Admin" styles={["pages/admin"]}>
            <h1 class="h3">Admin</h1>

            <h2 class="h4 mt-4">Admins ({staff.length})</h2>
            <p class="text-body-secondary">{viewer.is("owner") ? <>Owners can only be changed with <code>e621stream promote</code>.</> : "Only owners can add or remove admins."}</p>
            {viewer.is("owner") && <AddAdminForm />}
            <StaffList names={names} owner={viewer.is("owner")} staff={staff} />

            <h2 class="h4 mt-4" id="message-limits">Message Limits</h2>
            <p class="text-body-secondary">How many messages someone can send the gateway a minute, everyone else gets {GatewayConfig.maxMessagesPerMinute}. Leave it empty to go back to that.</p>
            <MessageLimitForm />
            {limited.length === 0 ? <p>Everyone has the default.</p> : <MessageLimitList limited={limited} names={names} />}

            <h2 class="h4 mt-4">Slow Mode</h2>
            <p class="text-body-secondary">Polls every feed slower for when e621 is responding slowly, without a redeploy.</p>
            <SlowModeSection slowMode={slowMode} />

            <h2 class="h4 mt-4" id="feeds">Feeds ({FEED_SOURCES.length})</h2>
            <p class="text-body-secondary">
                Paused feeds send nothing until they're resumed, what they missed can be recovered after.
                Slowing one down stacks with slow mode.
            </p>
            <FeedList controls={feedControls} health={feedHealth} recovering={isActive(recovery)} />

            <h2 class="h4 mt-4">Recovery</h2>
            <p class="text-body-secondary">
                Re-fetches a window of time the ingester missed, and sends what wasn't sent the first time as <code>recovered</code> events.
                Pick only the sources that actually missed things, the id based ones can only tell what was sent from what's still in the stream.
            </p>
            <RecoverySection recovery={recovery} />
        </Main>
    );
}

function AddAdminForm(): JSX.Element {
    return (
        <form method="post" action="/admin/admins" class="d-flex flex-wrap gap-2 mb-3">
            <input type="text" class="form-control w-auto" name="user_id" placeholder="e621 user id" inputmode="numeric" pattern="[0-9]+" required />
            <button type="submit" class="btn btn-primary">Add Admin</button>
        </form>
    );
}

function MessageLimitForm(): JSX.Element {
    return (
        <form method="post" action="/admin/message-limit" class="d-flex flex-wrap gap-2 mb-3">
            <input type="text" class="form-control w-auto" name="user_id" placeholder="e621 user id" inputmode="numeric" pattern="[0-9]+" required />
            <input type="number" class="form-control w-auto" name="limit" min={MESSAGE_LIMIT_MIN} max={MESSAGE_LIMIT_MAX} placeholder="messages a minute" />
            <button type="submit" class="btn btn-primary">Set</button>
        </form>
    );
}

function MessageLimitList({ limited, names }: { limited: Array<User>; names: Map<number, string> }): JSX.Element {
    return (
        <div class="table-responsive">
            <table class="table table-sm table-bordered data-table">
                <thead>
                    <tr>
                        <th scope="col">User</th>
                        <th scope="col">Messages a minute</th>
                        <th scope="col"></th>
                    </tr>
                </thead>
                <tbody>
                    {limited.map(user => (
                        <tr>
                            <td><a href={`https://e621.net/users/${user.id}`} safe>{names.get(user.id) ?? `#${user.id}`}</a></td>
                            <td>{user.messages_per_minute}</td>
                            <td><FormButton action="/admin/message-limit" buttonClass="btn-outline-secondary" fields={{ user_id: user.id, limit: "" }} text="Reset" /></td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function StaffList({ names, owner, staff }: { names: Map<number, string>; owner: boolean; staff: Array<User> }): JSX.Element {
    return (
        <div class="table-responsive">
            <table class="table align-middle">
                <thead>
                    <tr>
                        <th scope="col">User</th>
                        <th scope="col">Role</th>
                        <th scope="col">Last Login</th>
                        <th scope="col"></th>
                    </tr>
                </thead>
                <tbody>
                    {staff.map(user => (
                        <tr>
                            <td><a href={`https://e621.net/users/${user.id}`} safe>{names.get(user.id) ?? `#${user.id}`}</a></td>
                            <td class={user.role === "owner" ? "text-warning" : ""}>{user.role}</td>
                            <td><Time date={user.last_login_at} /></td>
                            <td class="text-end">
                                {owner && user.role === "admin" && (
                                    <FormButton action="/admin/admins/remove" buttonClass="btn-outline-danger" confirmText={`Remove ${names.get(user.id) ?? `#${user.id}`} as an admin?`} fields={{ user_id: user.id }} text="Remove" />
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function SlowModeSection({ slowMode }: { slowMode: SlowMode | null }): JSX.Element {
    if (slowMode) {
        return (
            <>
                <p>
                    <span class="text-info">Slow mode is on</span>, feeds are polled {slowMode.scale}x slower.
                    Turned on by <span safe>{slowMode.by}</span> at <Time date={new Date(slowMode.at)} />.
                </p>
                <FormButton action="/admin/slow/off" buttonClass="btn-outline-success" text="Turn Off" />
            </>
        );
    }
    return (
        <form method="post" action="/admin/slow" class="d-flex flex-wrap align-items-center gap-2">
            <input type="number" class="form-control w-auto" name="scale" min={SLOW_MODE_MIN_SCALE} max={SLOW_MODE_MAX_SCALE} value={String(SLOW_MODE_DEFAULT_SCALE)} required />
            <span>x slower</span>
            <button type="submit" class="btn btn-warning">Turn On Slow Mode</button>
        </form>
    );
}

function ago(iso: string | null | undefined): string {
    if (!iso) return "never";
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m ago`;
}

function FeedList({ controls, health, recovering }: { controls: Record<string, FeedControl>; health: Record<string, Partial<FeedHealth>>; recovering: boolean }): JSX.Element {
    return (
        <div class="table-responsive">
            <table class="table table-sm table-bordered data-table feed-table">
                <thead>
                    <tr>
                        <th scope="col">Feed</th>
                        <th scope="col">Every</th>
                        <th scope="col">Last poll</th>
                        <th scope="col">State</th>
                        <th scope="col" class="feed-actions"></th>
                    </tr>
                </thead>
                <tbody>
                    {FEED_SOURCES.map(({ intervalMS, name }) => (
                        <FeedRow name={name} intervalMS={intervalMS} control={controls[name] ?? null} health={health[name] ?? {}} recovering={recovering} />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function FeedRow({ control, health, intervalMS, name, recovering }: { control: FeedControl | null; health: Partial<FeedHealth>; intervalMS: number; name: string; recovering: boolean }): JSX.Element {
    const disabled = IngesterConfig.disabledSources.includes(name);
    const scale = control?.slow?.scale ?? null;
    return (
        <tr>
            <td><code safe>{name}</code></td>
            <td>{Math.round(intervalMS * (scale ?? 1) / 1000)}s{scale !== null && <span class="text-warning"> ({scale}x)</span>}</td>
            <td>
                {ago(health.last_ok_at)}
                {health.error && <div class="small text-danger text-break" safe>{health.error}</div>}
            </td>
            <td>
                {disabled
                    ? <span class="text-body-secondary">disabled</span>
                    : control?.paused
                        ? <span class="text-warning">paused by <span safe>{control.paused.by}</span>, <Time date={new Date(control.paused.at)} /></span>
                        : <span class="text-success">running</span>}
                {control?.slow && <div class="small text-body-secondary">slowed by <span safe>{control.slow.by}</span>, <Time date={new Date(control.slow.at)} /></div>}
            </td>
            <td class="feed-actions">{!disabled && <FeedActions name={name} recovering={recovering} control={control} />}</td>
        </tr>
    );
}

// the forms open under the buttons, one at a time, so the buttons never move
function FeedActions({ control, name, recovering }: { control: FeedControl | null; name: string; recovering: boolean }): JSX.Element {
    const id = `feed-${name}`;
    const recoverable = RECOVERABLE.includes(name);
    const toggle = (form: string, buttonClass: string, text: string): JSX.Element => (
        <button type="button" class={["btn", "btn-sm", buttonClass]} data-bs-toggle="collapse" data-bs-target={`#${id}-${form}`} aria-expanded="false" aria-controls={`${id}-${form}`}>{text}</button>
    );
    return (
        <div id={id}>
            <div class="d-flex gap-2">
                {control?.paused
                    ? <FormButton action="/admin/feeds/resume" buttonClass="btn-outline-success" fields={{ name }} text="Resume" />
                    : <FormButton action="/admin/feeds/pause" buttonClass="btn-outline-warning" confirmText={`Pause ${name}? Nothing it finds is sent until it's resumed.`} fields={{ name }} text="Pause" />}
                {control?.slow
                    ? <FormButton action="/admin/feeds/slow/off" buttonClass="btn-outline-secondary" fields={{ name }} text="Normal Speed" />
                    : toggle("slow", "btn-outline-secondary", "Slow")}
                {/* only one recovery runs at a time */}
                {recoverable && (recovering
                    ? <button type="button" class="btn btn-sm btn-outline-danger" disabled title="A recovery is already running">Recover</button>
                    : toggle("recover", "btn-outline-danger", "Recover"))}
            </div>
            {!control?.slow && (
                <div class="collapse" id={`${id}-slow`} data-bs-parent={`#${id}`}>
                    <form method="post" action="/admin/feeds/slow" class="d-flex gap-1 mt-2 mb-0">
                        <input type="hidden" name="name" value={name} />
                        <input type="number" class="form-control form-control-sm feed-scale" name="scale" min={SLOW_MODE_MIN_SCALE} max={SLOW_MODE_MAX_SCALE} value={String(SLOW_MODE_DEFAULT_SCALE)} aria-label={`How much slower to poll ${name}`} required />
                        <span class="align-self-center small text-nowrap">x slower</span>
                        <button type="submit" class="btn btn-sm btn-secondary">Set</button>
                    </form>
                </div>
            )}
            {recoverable && !recovering && (
                <div class="collapse" id={`${id}-recover`} data-bs-parent={`#${id}`}>
                    <form method="post" action="/admin/recovery" class="d-flex flex-column align-items-start gap-1 mt-2 mb-0" data-confirm={`Recover ${name}? Every client is told about it, and what's found is sent to them.`} onsubmit="return confirm(this.dataset.confirm)">
                        <input type="hidden" name="source" value={name} />
                        {/* size 1 so they fill the column instead of widening it */}
                        <input type="text" class="form-control form-control-sm" size="1" name="from" placeholder="from: iso time, or 6h ago" aria-label="From" required />
                        <input type="text" class="form-control form-control-sm" size="1" name="to" placeholder="to (default now)" aria-label="To" />
                        <button type="submit" class="btn btn-sm btn-danger">Start</button>
                    </form>
                </div>
            )}
        </div>
    );
}

function RecoverySection({ recovery }: { recovery: Recovery | null }): JSX.Element {
    const active = isActive(recovery);
    return (
        <>
            {recovery ? <CurrentRecovery recovery={recovery} /> : <p>No recoveries yet.</p>}
            {active ? <FormButton action="/admin/recovery/cancel" buttonClass="btn-outline-danger" confirmText="Cancel the recovery? What's been sent so far stays sent." text="Cancel" /> : <RecoveryForm />}
        </>
    );
}

function CurrentRecovery({ recovery }: { recovery: Recovery }): JSX.Element {
    return (
        <>
            <p>
                <code safe>{recovery.id}</code>: <span class={RECOVERY_CLASSES[recovery.status]}>{recovery.status}</span>,{" "}
                <Time date={new Date(recovery.from)} /> to <Time date={new Date(recovery.to)} />, {recovery.events} event(s).
                Requested by <span safe>{recovery.requested_by}</span> at <Time date={new Date(recovery.requested_at)} />.
                {recovery.error !== null && <> <span class="text-danger" safe>{recovery.error}</span></>}
            </p>
            <details class="mb-3">
                <summary>{recovery.sources.length} source(s)</summary>
                <div class="table-responsive">
                    <table class="table table-sm align-middle">
                        <thead>
                            <tr>
                                <th scope="col">Source</th>
                                <th scope="col">Status</th>
                                <th scope="col">Events</th>
                                <th scope="col"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {recovery.sources.map((name) => {
                                const progress = recovery.progress[name];
                                return (
                                    <tr>
                                        <td><code safe>{name}</code></td>
                                        <td safe>{progress?.status ?? ""}</td>
                                        <td>{progress?.events ?? 0}</td>
                                        <td>{progress?.error && <span class="text-danger" safe>{progress.error}</span>}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </details>
        </>
    );
}

function RecoveryForm(): JSX.Element {
    if (RECOVERABLE.length === 0) return <p class="text-warning">There aren't any sources that can be recovered.</p>;
    return (
        <form method="post" action="/admin/recovery" data-confirm="Start a recovery? Every client is told about it, and what's found is sent to them." onsubmit="return confirm(this.dataset.confirm)">
            <div class="d-flex flex-wrap gap-2 mb-2">
                <input type="text" class="form-control w-auto" name="from" placeholder="from: iso time, or 6h / 90m / 2d ago" required />
                <input type="text" class="form-control w-auto" name="to" placeholder="to (default now)" />
            </div>
            <details class="mb-2">
                <summary>Sources (all by default)</summary>
                <div class="d-flex gap-2 my-2">
                    <button type="button" class="btn btn-sm btn-outline-secondary" onclick="this.form.querySelectorAll('[name=source]').forEach(box => box.checked = true)">Select All</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" onclick="this.form.querySelectorAll('[name=source]').forEach(box => box.checked = false)">Clear</button>
                </div>
                <div class="row row-cols-1 row-cols-sm-2 row-cols-lg-4 g-1">
                    {RECOVERABLE.map(name => (
                        <div class="col form-check">
                            <input type="checkbox" class="form-check-input" name="source" id={`source-${name}`} value={name} checked />
                            <label class="form-check-label" for={`source-${name}`}><code safe>{name}</code></label>
                        </div>
                    ))}
                </div>
            </details>
            <button type="submit" class="btn btn-danger">Recover</button>
        </form>
    );
}
