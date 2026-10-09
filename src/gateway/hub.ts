import Debug from "@yiffy/debug";

import { streamKey } from "../config.ts";
import { parseEntry, type StreamEvent } from "../events.ts";
import { createRedis, type StreamEntry } from "../redis.ts";

import { sessions } from "./session.ts";

export const hubStats = { lastId: null as string | null, lastEventAt: null as string | null, received: 0 };

const reader = createRedis();

function fanOut(event: StreamEvent): void {
    for (const session of sessions) session.offer(event);
}

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
