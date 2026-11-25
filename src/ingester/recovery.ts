import Debug from "@yiffy/debug";

import Config from "../Config.ts";
import Redis, { parseEntry, type StreamEntry } from "../db/Redis.ts";
import { publishNotice, streamKey } from "../gateway/events.ts";
import { getRecovery, recoveryContext, saveRecovery, type Recovery } from "../gateway/recovery.ts";

import { Feed, FEEDS } from "./feeds.ts";
import { PostsFeed, type PostsCheckpoint } from "./posts.ts";
import { UpdateFeed, UPDATES } from "./updates.ts";

const CHECK_MS = 5000;
const STREAM_PAGE = 1000;

class Cancelled extends Error {}

/** Lets a long running source pick up where it left off after a restart */
export interface Checkpoint<T = unknown> {
    state: T | undefined;
    save(state: T, progress: { detail: string; events: number; fraction: number }): Promise<void>;
}

type Run = (from: number, to: number, stop: () => Promise<void>, sent: Map<string, Array<number>>, checkpoint: Checkpoint) => Promise<number>;

const RUNS: Record<string, Run> = {
    posts: (from, to, stop, sent, checkpoint) => new PostsFeed().recover(from, to, sent.get("post.create") ?? [], stop, checkpoint as Checkpoint<PostsCheckpoint>),
    ...Object.fromEntries(FEEDS.map((source): [string, Run] => [source.name, async (from, to, stop, sent): Promise<number> => new Feed(source).recover(from, to, sent.get(source.event) ?? [], stop)])),
    // window sources only see the newest few, so there's nothing to go back over
    ...Object.fromEntries(UPDATES.filter(source => source.mode === "ordered").map((source): [string, Run] => [source.name, async (from, to, stop): Promise<number> => new UpdateFeed(source).recover(from, to, stop)])),
};

export const RECOVERABLE = Object.keys(RUNS).filter(name => !Config.disabledSources.includes(name));

// creates already in the stream aren't sent again
async function alreadySent(from: number, sources: Array<string>): Promise<Map<string, Array<number>>> {
    const types = new Map<string, Array<number>>(FEEDS.filter(source => sources.includes(source.name)).map(source => [source.event, []]));
    if (sources.includes("posts")) types.set("post.create", []);
    if (types.size === 0) return types;
    let start = `${from}-0`;
    for (;;) {
        const entries = await Redis.send("XRANGE", [streamKey, start, "+", "COUNT", String(STREAM_PAGE)]) as Array<StreamEntry>;
        for (const entry of entries) {
            const item = parseEntry(entry);
            if (!item || "notice" in item) continue;
            const id = (item).data.id;
            if (typeof id === "number") types.get(item.type)?.push(id);
        }
        if (entries.length < STREAM_PAGE) return types;
        start = `(${entries.at(-1)![0]}`;
    }
}

const total = (recovery: Recovery): number => Object.values(recovery.progress).reduce((sum, progress) => sum + progress.events, 0);

async function notice(recovery: Recovery, done: boolean): Promise<void> {
    await publishNotice("recovery", { done, from: recovery.from, to: recovery.to, sources: recovery.sources, ...done ? { status: recovery.status, events: recovery.events } : {} });
}

async function run(recovery: Recovery): Promise<void> {
    const from = Date.parse(recovery.from), to = Date.parse(recovery.to);
    Debug("ingester:recovery", `${recovery.id}: recovering ${recovery.from} to ${recovery.to} for ${recovery.sources.join(", ")}`);
    // cancelling is done by an admin changing the stored status
    const stop = async (): Promise<void> => {
        if ((await getRecovery())?.status === "cancelled") throw new Cancelled();
    };
    const save = async (): Promise<void> => {
        const cancelled = (await getRecovery())?.status === "cancelled";
        if (cancelled) recovery.status = "cancelled";
        await saveRecovery(recovery);
        if (cancelled) throw new Cancelled();
    };

    const resumed = recovery.status === "running";
    recovery.status = "running";
    recovery.started_at ??= new Date().toISOString();
    await save();
    if (!resumed) await notice(recovery, false);
    try {
        const sent = await alreadySent(from, recovery.sources);
        for (const name of recovery.sources) {
            const progress = recovery.progress[name]!;
            if (progress.status === "done") continue;
            const fn = RUNS[name];
            if (!fn) {
                Object.assign(progress, { status: "failed", error: "can't be recovered" });
                continue;
            }
            progress.status = "running";
            await save();
            const checkpoint: Checkpoint = {
                state: progress.checkpoint,
                save: async (state, { detail, events, fraction }) => {
                    Object.assign(progress, { checkpoint: state, detail, events, fraction });
                    recovery.events = total(recovery);
                    await save();
                },
            };
            try {
                progress.events = await recoveryContext.run(recovery.id, () => fn(from, to, stop, sent, checkpoint));
                progress.status = "done";
                progress.fraction = 1;
                delete progress.checkpoint;
                delete progress.detail;
                Debug("ingester:recovery", `${recovery.id}: ${name} done, ${progress.events} event(s)`);
            } catch (err) {
                if (err instanceof Cancelled) throw err;
                Object.assign(progress, { status: "failed", error: String(err) });
                Debug("ingester:recovery", `${recovery.id}: ${name} failed: ${String(err)}`);
            }
            recovery.events = total(recovery);
            await save();
        }
        const failed = Object.values(recovery.progress).every(progress => progress.status === "failed");
        recovery.status = failed ? "failed" : "done";
        if (failed) recovery.error = "every source failed";
    } catch (err) {
        if (!(err instanceof Cancelled)) {
            recovery.status = "failed";
            recovery.error = String(err);
        }
        Debug("ingester:recovery", `${recovery.id}: ${recovery.status} (${recovery.error ?? "by an admin"})`);
    }
    recovery.finished_at = new Date().toISOString();
    await saveRecovery(recovery);
    await notice(recovery, true);
    Debug("ingester:recovery", `${recovery.id}: finished, ${recovery.events} event(s)`);
}

/** Runs recoveries requested from the admin page, and resumes one that was running before a restart */
export function startRecoveryWatch(): void {
    let busy = false;
    setInterval(() => {
        if (busy) return;
        busy = true;
        void getRecovery()
            .then(async (recovery) => {
                if (recovery?.status === "pending" || recovery?.status === "running") await run(recovery);
            })
            .catch((err: unknown) => { Debug("ingester:recovery", `failed: ${String(err)}`); })
            .finally(() => { busy = false; });
    }, CHECK_MS);
}
