import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import IngesterConfig from "../config/IngesterConfig.ts";
import Backfill from "../db/models/Backfill.ts";
import Redis from "../db/Redis.ts";
import { getSlowMode } from "../gateway/slowMode.ts";

// written by gateway/presence.ts, a count of sessions for each gateway
const clientsKey = `${Config.redisPrefix}clients`;
const idleKey = `${Config.redisPrefix}ingester:idle`;
const CHECK_MS = 15_000;

let idle = false;
let slow = 1;
const wakers: Array<() => void> = [];

/** How much slower than normal to poll */
export const pollScale = (): number => (idle ? IngesterConfig.idlePollScale : 1) * slow;

/** Called when polling speeds back up, so feeds don't sit out a long wait */
export function onWake(fn: () => void): void {
    wakers.push(fn);
}

async function backfilling(): Promise<boolean> {
    if (!IngesterConfig.backfillEnabled) return false;
    return (await Backfill.all()).some(backfill => backfill.status !== "done");
}

async function check(): Promise<void> {
    const before = pollScale();
    const clients = Object.values(await Redis.hgetall(clientsKey)).reduce((total, n) => total + Number(n), 0);
    // only slowed down while backfilling, so the backfill gets more of the ratelimit
    const now = clients === 0 && IngesterConfig.idlePollScale > 1 && await backfilling();
    await Redis.set(idleKey, String(now));
    if (now !== idle) {
        idle = now;
        Debug("ingester", idle ? `nobody's connected, polling ${IngesterConfig.idlePollScale}x slower` : clients === 0 ? "nothing left to backfill, back to polling at full speed" : `${clients} client(s) connected, back to polling at full speed`);
    }

    const mode = await getSlowMode();
    if ((mode?.scale ?? 1) !== slow) {
        slow = mode?.scale ?? 1;
        Debug("ingester", mode ? `slow mode turned on by ${mode.by}, polling ${mode.scale}x slower` : "slow mode turned off");
    }
    if (pollScale() < before) for (const wake of wakers) wake();
}

export async function startIdleWatch(): Promise<void> {
    await check().catch(() => null);
    setInterval(() => void check().catch((err: unknown) => { Debug("ingester", `idle check failed: ${String(err)}`); }), CHECK_MS);
}
