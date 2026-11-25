import Debug from "@yiffy/debug";

import { createRedis, parseEntry, type StreamEntry } from "../db/Redis.ts";
import { logEvent } from "../util/FileLog.ts";

import { streamKey, type StreamItem } from "./events.ts";

import type Session from "./Session.ts";

const BLOCK_MS = 5000;
const READ_COUNT = 1000;
const RETRY_MS = 1000;

// one at a time, so every session gets them in order
async function fanOut(sessions: Array<Session>, item: StreamItem): Promise<void> {
    // closing can remove from sessions
    const results = await Promise.all([...sessions].map(async session => session.offer(item).catch(() => false)));
    logEvent(() => JSON.stringify(item), results.filter(Boolean).length);
}

/** Reads new events off the stream and gives them to every session on this gateway */
export async function startHub(sessions: Array<Session>): Promise<never> {
    // blocking reads hold the connection, so it needs its own
    const reader = createRedis();
    let lastID = "$";
    for (;;) {
        try {
            const result = await reader.send("XREAD", ["COUNT", String(READ_COUNT), "BLOCK", String(BLOCK_MS), "STREAMS", streamKey, lastID]) as Record<string, Array<StreamEntry>> | null;
            for (const entry of result?.[streamKey] ?? []) {
                lastID = entry[0];
                const item = parseEntry(entry);
                if (item) await fanOut(sessions, item);
            }
        } catch (err) {
            Debug("gateway:hub", `read failed: ${String(err)}`);
            await Bun.sleep(RETRY_MS);
        }
    }
}
