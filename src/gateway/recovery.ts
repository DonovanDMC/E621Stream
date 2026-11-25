import { AsyncLocalStorage } from "node:async_hooks";

import Config from "../Config.ts";
import Redis from "../db/Redis.ts";
import I18n from "../util/I18n.ts";

import type { Notice } from "./events.ts";

export type RecoveryStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type SourceStatus = "pending" | "running" | "done" | "failed";

export interface RecoveryNotice extends Notice<"recovery"> {
    done: boolean;
    events?: number;
    from: string; // ISO timestamp
    sources: Array<string>;
    status?: RecoveryStatus;
    to: string; // ISO timestamp
}

export interface SourceProgress {
    checkpoint?: unknown;
    detail?: string;
    error: string | null;
    events: number;
    fraction?: number;
    status: SourceStatus;
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

// set while the ingester runs a recovery, so what it publishes is marked as recovered
export const recoveryContext = new AsyncLocalStorage<string>();
export const isRecovering = (): boolean => recoveryContext.getStore() !== undefined;

export const isActive = (recovery: Recovery | null): recovery is Recovery => recovery?.status === "pending" || recovery?.status === "running";

export function toEvent(recovery: Recovery): RecoveryNotice {
    return {
        done: recovery.status === "done",
        events: recovery.events,
        from: recovery.from,
        id: recovery.id,
        notice: true,
        sources: recovery.sources,
        status: recovery.status,
        time: recovery.requested_at,
        to: recovery.to,
        type: "recovery",
    };
}

const recoveryKey = `${Config.redisPrefix}recovery`;
export async function getRecovery(): Promise<Recovery | null> {
    const raw = await Redis.get(recoveryKey);
    return raw ? JSON.parse(raw) as Recovery : null;
}

export async function saveRecovery(recovery: Recovery): Promise<void> {
    await Redis.set(recoveryKey, JSON.stringify(recovery));
}

const recoveryHistoryKey = `${Config.redisPrefix}recovery:history`;
const MAX_HISTORY = 50;

export async function getRecoveryHistory(limit = 20): Promise<Array<Recovery>> {
    const entries = await Redis.lrange(recoveryHistoryKey, 0, limit - 1);
    return entries.map(entry => JSON.parse(entry) as Recovery);
}

/** Gives the reason as a string when it can't be started */
export async function requestRecovery(from: Date, to: Date, sources: Array<string>, by: string): Promise<Recovery | string> {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return I18n.t("web.admin.recovery.invalidTime");
    if (from >= to) return I18n.t("web.admin.recovery.backwards");
    if (to.getTime() > Date.now()) return I18n.t("web.admin.recovery.future");
    if (sources.length === 0) return I18n.t("web.admin.recovery.noSources");
    const previous = await getRecovery();
    // not isActive, its guard would narrow previous to null after this
    if (previous?.status === "pending" || previous?.status === "running") return I18n.t("web.admin.recovery.alreadyRunning");
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
        // checkpoints are only useful while it's running
        for (const progress of Object.values(previous.progress)) delete progress.checkpoint;
        await Redis.lpush(recoveryHistoryKey, JSON.stringify(previous));
        await Redis.ltrim(recoveryHistoryKey, 0, MAX_HISTORY - 1);
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
