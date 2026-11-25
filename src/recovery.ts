import { AsyncLocalStorage } from "node:async_hooks";

import { recoveryHistoryKey, recoveryKey } from "./config.ts";
import redis from "./redis.ts";

const MAX_HISTORY = 50;

export type RecoveryStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface SourceProgress {
    checkpoint?: unknown;
    detail?: string;
    error: string | null;
    events: number;
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

export const recoveryContext = new AsyncLocalStorage<string>();

export async function getRecovery(): Promise<Recovery | null> {
    const raw = await redis.get(recoveryKey);
    return raw ? JSON.parse(raw) as Recovery : null;
}

export async function saveRecovery(recovery: Recovery): Promise<void> {
    await redis.set(recoveryKey, JSON.stringify(recovery));
}

export const isActive = (recovery: Recovery | null): recovery is Recovery => recovery?.status === "pending" || recovery?.status === "running";

export async function getRecoveryHistory(limit = 20): Promise<Array<Recovery>> {
    const entries = await redis.send("LRANGE", [recoveryHistoryKey, "0", String(limit - 1)]) as Array<string>;
    return entries.map(entry => JSON.parse(entry) as Recovery);
}

export async function requestRecovery(from: Date, to: Date, sources: Array<string>, by: string): Promise<Recovery | string> {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "invalid time";
    if (from >= to) return "from has to be before to";
    if (to.getTime() > Date.now()) return "to can't be in the future";
    if (sources.length === 0) return "no sources";
    const previous = await getRecovery();
    if (previous?.status === "pending" || previous?.status === "running") return "a recovery is already running";
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
    if (previous) {
        for (const progress of Object.values(previous.progress)) delete progress.checkpoint;
        await redis.send("LPUSH", [recoveryHistoryKey, JSON.stringify(previous)]);
        await redis.send("LTRIM", [recoveryHistoryKey, "0", String(MAX_HISTORY - 1)]);
    }
    await saveRecovery(recovery);
    return recovery;
}

export async function cancelRecovery(): Promise<boolean> {
    const recovery = await getRecovery();
    if (!isActive(recovery)) return false;
    await saveRecovery({ ...recovery, status: "cancelled" });
    return true;
}
