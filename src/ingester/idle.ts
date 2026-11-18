import Debug from "@yiffy/debug";

import { listStates } from "../backfill/state.ts";
import { backfillEnabled, clientsKey, idleKey, idlePollScale } from "../config.ts";
import redis from "../redis.ts";
import { getSlowMode } from "../slowMode.ts";

// while nobody's connected to any gateway and the backfill isn't done, feeds poll IDLE_POLL_SCALE times slower so
// the backfill gets most of the requests. nobody's there to miss the delay, and nothing's lost since feeds carry on
// from their cursor. as soon as someone connects it goes back to full speed
// slow mode (../slowMode.ts) is checked here too, it stacks with idle
const CHECK_MS = 15_000;

let idle = false;
let slow = 1;
const wakers = new Set<() => void>();

// what feed intervals are multiplied by right now
export const pollScale = (): number => (idle ? idlePollScale : 1) * slow;

// called when polling speeds up, so feeds can poll right away instead of finishing their slow wait
export function onWake(fn: () => void): void {
    wakers.add(fn);
}

// the client count comes from every gateway's presence report (gateway/presence.ts)
async function check(): Promise<void> {
    const before = pollScale();
    const counts = await redis.send("HVALS", [clientsKey]) as Array<string>;
    const clients = counts.reduce((total, n) => total + Number(n), 0);
    const backfilling = backfillEnabled && (await listStates()).some(state => state.status !== "done");
    const now = clients === 0 && backfilling && idlePollScale > 1;
    await redis.set(idleKey, String(now));
    if (now !== idle) {
        idle = now;
        Debug("ingester", idle ? `nobody's connected, polling ${idlePollScale}x slower` : clients === 0 ? "nothing left to backfill, back to polling at full speed" : `${clients} client(s) connected, back to polling at full speed`);
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
    setInterval(() => void check().catch((err: unknown) => { Debug("ingester", `client check failed: ${String(err)}`); }), CHECK_MS);
}
