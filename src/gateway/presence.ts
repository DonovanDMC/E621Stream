import Config from "../Config.ts";
import Redis from "../db/Redis.ts";

import { sessions, type SessionState } from "./Session.ts";

import type { CompiledSubscription } from "./filter";

export interface ListedClient {
    client: string | null;
    connected_at: string;
    ip: string;
    session_id: string;
    state: Exclude<SessionState, "closed">;
    subscriptions: Array<CompiledSubscription>;
    user: string | null;
    user_id: number | null;
}

const id = crypto.randomUUID();
const REPORT_MS = 5000;
const TTL_SECONDS = 30;
const clientsKey = `${Config.redisPrefix}clients`;
const clientListKey = `${Config.redisPrefix}clients:list`;

let last = -1;
async function report(): Promise<void> {
    const listed: Array<ListedClient> = sessions
        .filter(s => s.isNot("closed"))
        .map(s => ({
            client: s.client,
            connected_at: s.connectedAt.toISOString(),
            ip: s.ws.data.ip,
            session_id: s.id,
            state: s.state as ListedClient["state"],
            subscriptions: s.subscriptions,
            user: s.user?.name ?? null,
            user_id: s.user?.id ?? null,
        }));

    await Redis.hset(clientsKey, id, String(sessions.length));
    await Redis.hexpire(clientsKey, TTL_SECONDS, "FIELDS", 1, id);
    await Redis.hset(clientListKey, id, JSON.stringify(listed));
    await Redis.hexpire(clientListKey, TTL_SECONDS, "FIELDS", 1, id);
    last = sessions.length;
}

// every gateway's clients, from their last report
export async function listClients(): Promise<Array<ListedClient>> {
    const lists = await Redis.hvals(clientListKey);
    return lists.flatMap(list => JSON.parse(list) as Array<ListedClient>).sort((a, b) => a.connected_at.localeCompare(b.connected_at));
}

export function startPresence(): void {
    void report().catch(() => null);
    setInterval(() => void report().catch(() => null), REPORT_MS);
}

export function connectionsChanged(): void {
    if (last === 0 && sessions.length !== 0) void report().catch(() => null);
}
