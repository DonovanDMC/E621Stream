import { clientListKey, clientsKey } from "../config.ts";
import redis from "../redis.ts";

import { sessions, type State } from "./session.ts";

import type { Subscription } from "./filter.ts";

// every few seconds each gateway writes how many connections it has (for the ingester's idle check & the status page)
// and a list of them (for the admin page) under its own field. the fields expire, so a gateway that dies drops off
// on its own

export interface ListedClient {
    client: string | null;
    connected_at: string;
    ip: string;
    session_id: string;
    state: Exclude<State, "closed">;
    subscriptions: Array<Subscription>;
    user: string | null;
    user_id: number | null;
}

// this gateway's field
const id = crypto.randomUUID();
const REPORT_MS = 5000;
const TTL_SECONDS = 30;

// the count in the last report
let last = -1;
// HEXPIRE needs redis 7.4+
async function report(): Promise<void> {
    const listed: Array<ListedClient> = [...sessions]
        .filter(session => session.state !== "closed")
        .map(session => ({
            client: session.client,
            connected_at: session.connectedAt.toISOString(),
            ip: session.ws.data.ip,
            session_id: session.id,
            state: session.state as Exclude<State, "closed">,
            subscriptions: session.activeSubscriptions(),
            user: session.user?.name ?? null,
            user_id: session.user?.id ?? null,
        }));
    await redis.send("HSET", [clientsKey, id, String(sessions.size)]);
    await redis.send("HEXPIRE", [clientsKey, String(TTL_SECONDS), "FIELDS", "1", id]);
    await redis.send("HSET", [clientListKey, id, JSON.stringify(listed)]);
    await redis.send("HEXPIRE", [clientListKey, String(TTL_SECONDS), "FIELDS", "1", id]);
    last = sessions.size;
}

export function startPresence(): void {
    void report().catch(() => null);
    setInterval(() => void report().catch(() => null), REPORT_MS);
}

// reports right away when the first client connects, so the ingester wakes up without waiting for the next report
export function connectionsChanged(): void {
    if (last === 0 && sessions.size !== 0) void report().catch(() => null);
}
