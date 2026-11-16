import Debug from "@yiffy/debug";

import { streamKey } from "../config.ts";
import { dispatchFrame, isNotice, noticeFrame, parseEntry, type StreamItem } from "../events.ts";
import { logEvent } from "../logs.ts";
import { createRedis, type StreamEntry } from "../redis.ts";

import { sessions } from "./session.ts";

// reads the event stream as it's added to and offers everything to every session on this gateway
// each gateway reads the whole stream on its own, there's no consumer group, so adding gateways is free for redis

// for /health, /stats & the status page. notices don't count
export const hubStats = { lastId: null as string | null, lastEventAt: null as string | null, received: 0 };

// XREAD BLOCK holds the connection, so it gets its own
const reader = createRedis();

function fanOut(event: StreamItem): void {
    let sent = 0;
    for (const session of sessions) if (session.offer(event)) sent++;
    logEvent(() => isNotice(event) ? noticeFrame(event) : dispatchFrame(event), sent);
}

// never returns. $ is "only what's added from now on", after that it's the last id read. anything older is only sent
// to clients that ask for it with a cursor (replay in session.ts)
export async function startHub(): Promise<void> {
    let lastId = "$";
    for (;;) {
        try {
            const res = await reader.send("XREAD", ["COUNT", "1000", "BLOCK", "5000", "STREAMS", streamKey, lastId]) as Record<string, Array<StreamEntry>> | null;
            const entries = res?.[streamKey] ?? [];
            for (const entry of entries) {
                lastId = entry[0];
                const event = parseEntry(entry);
                if (!event) continue;
                if (isNotice(event)) {
                    fanOut(event);
                    continue;
                }
                hubStats.received++;
                hubStats.lastId = event.id;
                hubStats.lastEventAt = event.time;
                fanOut(event);
            }
        } catch (err) {
            Debug("gateway:hub", `read failed: ${String(err)}`);
            await Bun.sleep(1000);
        }
    }
}
