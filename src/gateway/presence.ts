import { clientsKey } from "../config.ts";
import redis from "../redis.ts";

import { sessions } from "./session.ts";

const id = crypto.randomUUID();
const REPORT_MS = 5000;
const TTL_SECONDS = 30;

let last = -1;
async function report(): Promise<void> {
    await redis.send("HSET", [clientsKey, id, String(sessions.size)]);
    await redis.send("HEXPIRE", [clientsKey, String(TTL_SECONDS), "FIELDS", "1", id]);
    last = sessions.size;
}

export function startPresence(): void {
    void report().catch(() => null);
    setInterval(() => void report().catch(() => null), REPORT_MS);
}

export function connectionsChanged(): void {
    if (last === 0 && sessions.size !== 0) void report().catch(() => null);
}
