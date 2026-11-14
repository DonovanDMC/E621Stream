import Debug from "@yiffy/debug";

import { disabledSources, streamKey } from "../config.ts";
import { publishNotice } from "../events.ts";
import { getRecovery, notice, recoveryContext, saveRecovery, type Recovery } from "../recovery.ts";
import redis, { fieldsToObject, type StreamEntry } from "../redis.ts";

import { Feed, FEEDS } from "./feeds.ts";
import { PostsFeed } from "./posts.ts";
import { UpdateFeed, UPDATES } from "./updates.ts";

class Cancelled extends Error {}

type Run = (from: number, to: number, stop: () => Promise<void>, sent: Map<string, Set<number>>) => Promise<number>;

// window mode update sources only ever see their newest page, so there's nothing to go back through
const RUNS: Record<string, Run> = {
    posts: (from, to, stop, sent) => new PostsFeed().recover(from, to, sent.get("post.create") ?? new Set(), stop),
    ...Object.fromEntries(FEEDS.map(source => [source.name, ((from, to, stop, sent): Promise<number> => new Feed(source).recover(from, to, sent.get(source.event) ?? new Set(), stop)) satisfies Run])),
    ...Object.fromEntries(UPDATES.filter(source => source.mode === "ordered").map(source => [source.name, ((from, to, stop): Promise<number> => new UpdateFeed(source).recover(from, to, stop)) satisfies Run])),
};

export const RECOVERABLE = Object.keys(RUNS).filter(name => !disabledSources.has(name));

// ids of what the id feeds (and post.create) already published since `from`, recovered or not. there's no snapshots to
// tell from
async function alreadySent(from: number, sources: Array<string>): Promise<Map<string, Set<number>>> {
    const types = new Map(FEEDS.filter(source => sources.includes(source.name)).map(source => [source.event as string, new Set<number>()]));
    if (sources.includes("posts")) types.set("post.create", new Set());
    if (types.size === 0) return types;
    // stream ids are when it was published, which is never before it happened
    let start = `${from}-0`;
    for (;;) {
        const entries = await redis.send("XRANGE", [streamKey, start, "+", "COUNT", "1000"]) as Array<StreamEntry>;
        for (const [, fields] of entries) {
            const { t, d } = fieldsToObject(fields);
            const ids = t === undefined ? undefined : types.get(t);
            if (!ids || d === undefined) continue;
            const data = JSON.parse(d) as { id?: unknown; post?: { id?: unknown } };
            const id = t === "post.create" ? data.post?.id : data.id;
            if (typeof id === "number") ids.add(id);
        }
        if (entries.length < 1000) return types;
        start = `(${entries.at(-1)![0]}`;
    }
}

async function run(recovery: Recovery): Promise<void> {
    const from = Date.parse(recovery.from), to = Date.parse(recovery.to);
    Debug("ingester:recovery", `${recovery.id}: recovering ${recovery.from} to ${recovery.to} for ${recovery.sources.join(", ")}`);
    let cancelled = false;
    // saves progress, unless it was cancelled from the admin page in the meantime
    const save = async (): Promise<void> => {
        if ((await getRecovery())?.status === "cancelled") cancelled = true;
        if (cancelled) recovery.status = "cancelled";
        await saveRecovery(recovery);
        if (cancelled) throw new Cancelled();
    };
    const stop = async (): Promise<void> => {
        if ((await getRecovery())?.status === "cancelled") throw new Cancelled();
    };

    recovery.status = "running";
    recovery.started_at ??= new Date().toISOString();
    await save();
    await publishNotice(notice(recovery, false));
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
            try {
                progress.events = await recoveryContext.run(recovery.id, () => fn(from, to, stop, sent));
                progress.status = "done";
                Debug("ingester:recovery", `${recovery.id}: ${name} done, ${progress.events} event(s)`);
            } catch (err) {
                if (err instanceof Cancelled) throw err;
                Object.assign(progress, { status: "failed", error: String(err) });
                Debug("ingester:recovery", `${recovery.id}: ${name} failed: ${String(err)}`);
            }
            recovery.events = Object.values(recovery.progress).reduce((total, p) => total + p.events, 0);
            await save();
        }
        const failed = Object.values(recovery.progress).every(p => p.status === "failed");
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
    await publishNotice(notice(recovery, true));
    Debug("ingester:recovery", `${recovery.id}: finished, ${recovery.events} event(s)`);
}

// picks up recoveries requested from the admin page. one that was running when the ingester stopped is picked back up,
// sources that finished are skipped
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
    }, 5000);
}
