// Adds fake recoveries to see how the admin and status pages show them, clear takes them out again.
// --running adds one that's still going. The ingester picks those up within 5 seconds, its sources aren't real
// feeds so all it can do is fail them, stop the ingester first to keep it running.
// usage: bun scripts/fakeRecoveries.ts <add [--running]|clear>
import Config from "../src/Config.ts";
import Redis from "../src/db/Redis.ts";
import { getRecovery, saveRecovery, type Recovery, type SourceProgress } from "../src/gateway/recovery.ts";

const historyKey = `${Config.redisPrefix}recovery:history`;
const PREFIX = "rfake";
const HOUR = 60 * 60 * 1000;

const at = (hoursAgo: number): string => new Date(Date.now() - (hoursAgo * HOUR)).toISOString();
const progress = (status: SourceProgress["status"], events: number, extra: Partial<SourceProgress> = {}): SourceProgress => ({ status, events, error: null, ...extra });

function recovery(id: string, hoursAgo: number, status: Recovery["status"], progressBySource: Record<string, SourceProgress>, error: string | null = null): Recovery {
    const finished = status === "done" || status === "failed" || status === "cancelled";
    return {
        id: `${PREFIX}${id}`,
        from: at(hoursAgo + 6),
        to: at(hoursAgo + 2),
        sources: Object.keys(progressBySource),
        status,
        requested_by: "fake",
        requested_at: at(hoursAgo + 1),
        started_at: at(hoursAgo + 1),
        finished_at: finished ? at(hoursAgo) : null,
        events: Object.values(progressBySource).reduce((total, p) => total + p.events, 0),
        error,
        progress: progressBySource,
    };
}

// newest first
const HISTORY: Array<Recovery> = [
    recovery("5", 3, "done", { posts: progress("done", 1520, { fraction: 1 }), comments: progress("done", 84, { fraction: 1 }), comment_updates: progress("done", 12, { fraction: 1 }) }),
    recovery("4", 20, "done", { post_versions: progress("done", 3011, { fraction: 1 }), post_events: progress("failed", 0, { error: "post_events returned 403" }) }),
    recovery("3", 50, "cancelled", { posts: progress("running", 402, { fraction: 0.31, detail: "ids 1..6883300, page 4" }), notes: progress("pending", 0) }),
    recovery("2", 120, "failed", { tags: progress("failed", 0, { error: "UnexpectedResponseError: Network error on GET https://e621.net/tags.json" }), wiki_pages: progress("failed", 0, { error: "can't be recovered" }) }, "every source failed"),
    recovery("1", 300, "done", { forum_posts: progress("done", 7, { fraction: 1 }) }),
];

const CURRENT = recovery("6", 0.2, "done", {
    posts: progress("done", 2290, { fraction: 1 }),
    comments: progress("done", 133, { fraction: 1 }),
    forum_topic_updates: progress("failed", 0, { error: "forum_topics returned 500" }),
    tag_alias_updates: progress("done", 4, { fraction: 1 }),
});

const RUNNING = recovery("7", 0, "running", {
    fake_posts: progress("running", 818, { fraction: 0.42, detail: "ids 3441651..6883300, page 12, back to 2026-11-25T14:02:00.000Z" }),
    fake_comments: progress("done", 51, { fraction: 1 }),
    fake_tags: progress("failed", 0, { error: "tags returned 502" }),
    fake_notes: progress("pending", 0),
});

const [command, flag] = process.argv.slice(2);
switch (command) {
    case "add": {
        const current = await getRecovery();
        if (current && !current.id.startsWith(PREFIX)) {
            console.error(`there's a real recovery stored (${current.id}), not replacing it`);
            process.exit(1);
        }
        // pushed oldest first, so the newest ends up at the front
        for (const entry of HISTORY.toReversed()) await Redis.lpush(historyKey, JSON.stringify(entry));
        await saveRecovery(flag === "--running" ? RUNNING : CURRENT);
        console.log(`added ${HISTORY.length} past recoveries and a ${flag === "--running" ? "running" : "finished"} one`);
        break;
    }
    case "clear": {
        const history = await Redis.lrange(historyKey, 0, -1);
        const fake = history.filter(entry => (JSON.parse(entry) as Recovery).id.startsWith(PREFIX));
        for (const entry of fake) await Redis.lrem(historyKey, 0, entry);
        const current = await getRecovery();
        if (current?.id.startsWith(PREFIX)) await Redis.del(`${Config.redisPrefix}recovery`);
        console.log(`removed ${fake.length} past recoveries${current?.id.startsWith(PREFIX) ? " and the current one" : ""}`);
        break;
    }
    default: {
        console.error("usage: bun scripts/fakeRecoveries.ts <add [--running]|clear>");
        process.exit(1);
    }
}
process.exit(0);
