import Debug from "@yiffy/debug";

import { listStates } from "../backfill/state.ts";
import { backfillEnabled, clientsKey, idleKey, idlePollScale } from "../config.ts";
import redis from "../redis.ts";

const CHECK_MS = 15_000;

let idle = false;
const wakers = new Set<() => void>();

export const idleScale = (): number => idle ? idlePollScale : 1;

export function onWake(fn: () => void): void {
    wakers.add(fn);
}

async function check(): Promise<void> {
    const counts = await redis.send("HVALS", [clientsKey]) as Array<string>;
    const clients = counts.reduce((total, n) => total + Number(n), 0);
    const backfilling = backfillEnabled && (await listStates()).some(state => state.status !== "done");
    const now = clients === 0 && backfilling && idlePollScale > 1;
    await redis.set(idleKey, String(now));
    if (now === idle) return;
    idle = now;
    Debug("ingester", idle ? `nobody's connected, polling ${idlePollScale}x slower` : clients === 0 ? "nothing left to backfill, back to polling at full speed" : `${clients} client(s) connected, back to polling at full speed`);
    if (!idle) for (const wake of wakers) wake();
}

export async function startIdleWatch(): Promise<void> {
    await check().catch(() => null);
    setInterval(() => void check().catch((err: unknown) => { Debug("ingester", `client check failed: ${String(err)}`); }), CHECK_MS);
}
