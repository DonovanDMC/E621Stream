import { clientListKey, clientsKey } from "../config.ts";
import redis from "../redis.ts";

import { sessions, type State } from "./session.ts";

import type { Subscription } from "./filter.ts";

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

const id = crypto.randomUUID();
const REPORT_MS = 5000;
const TTL_SECONDS = 30;

let last = -1;
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

export function connectionsChanged(): void {
    if (last === 0 && sessions.size !== 0) void report().catch(() => null);
}
