import { AsyncLocalStorage } from "node:async_hooks";

import { recoveryKey } from "./config.ts";
import redis from "./redis.ts";

// re-fetching a window of time the ingester missed. the gateway asks for one, the ingester runs it

export type RecoveryStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface SourceProgress {
    /** where a source that saves its spot got to, so a restart carries on from there */
    checkpoint?: unknown;
    /** where it is, for the status page */
    detail?: string;
    error: string | null;
    events: number;
    /** how far through the window it is, 0-1, for sources that know */
    fraction?: number;
    status: "pending" | "running" | "done" | "failed";
}

export interface Recovery {
    error: string | null;
    events: number;
    finished_at: string | null;
    from: string;
    id: string;
    progress: Record<string, SourceProgress>;
    requested_at: string;
    requested_by: string;
    sources: Array<string>;
    started_at: string | null;
    status: RecoveryStatus;
    to: string;
}

// what's sent to clients in `recovery` & `ready`
export interface RecoveryNotice {
    done: boolean;
    events?: number;
    from: string;
    id: string;
    sources: Array<string>;
    status?: RecoveryStatus;
    to: string;
}

export const notice = (recovery: Recovery, done: boolean): RecoveryNotice => ({
    id: recovery.id,
    from: recovery.from,
    to: recovery.to,
    sources: recovery.sources,
    done,
    ...done ? { status: recovery.status, events: recovery.events } : {},
});

// set while a recovery is publishing, so everything it publishes (follow-ups too) gets flagged
export const recoveryContext = new AsyncLocalStorage<string>();

export async function getRecovery(): Promise<Recovery | null> {
    const raw = await redis.get(recoveryKey);
    return raw ? JSON.parse(raw) as Recovery : null;
}

export async function saveRecovery(recovery: Recovery): Promise<void> {
    await redis.set(recoveryKey, JSON.stringify(recovery));
}

export const isActive = (recovery: Recovery | null): recovery is Recovery => recovery?.status === "pending" || recovery?.status === "running";

export async function requestRecovery(from: Date, to: Date, sources: Array<string>, by: string): Promise<Recovery | string> {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "invalid time";
    if (from >= to) return "from has to be before to";
    if (to.getTime() > Date.now()) return "to can't be in the future";
    if (sources.length === 0) return "no sources";
    if (isActive(await getRecovery())) return "a recovery is already running";
    const recovery: Recovery = {
        id: `r${Date.now().toString(36)}`,
        from: from.toISOString(),
        to: to.toISOString(),
        sources,
        status: "pending",
        requested_by: by,
        requested_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        events: 0,
        error: null,
        progress: Object.fromEntries(sources.map(source => [source, { status: "pending", events: 0, error: null }])),
    };
    await saveRecovery(recovery);
    return recovery;
}

export async function cancelRecovery(): Promise<boolean> {
    const recovery = await getRecovery();
    if (!isActive(recovery)) return false;
    // the ingester checks for this between pages
    await saveRecovery({ ...recovery, status: "cancelled" });
    return true;
}
