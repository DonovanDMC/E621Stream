import { TRACKED } from "../ingester/updates.ts";

// the websocket protocol's shapes & parsing. every message both ways is { op, d }. client ops: identify, subscribe,
// snapshot, heartbeat. server ops: hello, ready, dispatch, replay_complete, subscribed, snapshot, heartbeat_ack,
// recovery, error. pages/index.md has the full description

// in /info and hello, bumped for breaking changes
export const PROTOCOL_VERSION = 1;

// sent as the websocket close code, and in the error message before it. pages/close-codes.md lists what each means
export const CloseCodes = {
    UNKNOWN_ERROR: 4000,
    UNKNOWN_OP: 4001,
    DECODE_ERROR: 4002,
    NOT_IDENTIFIED: 4003,
    AUTHENTICATION_FAILED: 4004,
    ALREADY_IDENTIFIED: 4005,
    INVALID_SUBSCRIPTION: 4006,
    INVALID_CURSOR: 4007,
    RATE_LIMITED: 4008,
    SLOW_CONSUMER: 4009,
    TOO_MANY_CONNECTIONS: 4010,
    AUTHENTICATION_EXPIRED: 4011,
    DISCONNECTED: 4012,
    BANNED: 4013,
} as const;
export type CloseCode = typeof CloseCodes[keyof typeof CloseCodes];

export interface IdentifyPayload {
    auth?: { api_key: string; username: string } | { token: string };
    // a name for the client, shown on the admin page
    client?: string;
    // a stream id (or just its ms part) to replay from
    cursor?: string | number;
    // strings ("post.*") or { type, filter } objects, see filter.ts
    subscriptions: Array<unknown>;
}

export interface SnapshotRequest { ids: Array<number>; nonce: string | null; resource: string }

export type ClientMessage
    = | { d: IdentifyPayload; op: "identify" }
        | { d: { subscriptions: Array<unknown> }; op: "subscribe" }
        | { d?: unknown; op: "snapshot" }
        | { d?: unknown; op: "heartbeat" };

// what can be looked up with the snapshot op
export const SNAPSHOT_RESOURCES = ["post", ...Object.values(TRACKED).map(tracked => tracked.resource)];
const snapshotResourceSet = new Set<string>(SNAPSHOT_RESOURCES);

// a string back is the error, ids are deduped. nonce is echoed back so clients can match up answers
export function parseSnapshotRequest(value: unknown, max: number): SnapshotRequest | string {
    if (!value || typeof value !== "object") return "missing payload";
    const { resource, ids, nonce } = value as Record<string, unknown>;
    if (typeof resource !== "string" || !snapshotResourceSet.has(resource)) return `unknown resource "${String(resource)}"`;
    if (!Array.isArray(ids) || ids.length === 0) return "no ids";
    if (ids.length > max) return `too many ids (max ${max})`;
    if (!ids.every(id => Number.isSafeInteger(id) && id > 0)) return "ids must be positive integers";
    if (nonce !== undefined && (typeof nonce !== "string" || nonce.length > 100)) return "invalid nonce";
    return { resource, ids: [...new Set(ids as Array<number>)], nonce: nonce ?? null };
}

// a full stream id, or a bare ms timestamp (number or string) which becomes <ms>-0
export function parseCursor(value: unknown): string | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return `${value}-0`;
    if (typeof value !== "string") return null;
    if (/^\d+$/.test(value)) return `${value}-0`;
    return /^\d+-\d+$/.test(value) ? value : null;
}

// stream ids can't be compared as strings ("9-0" > "10-0")
export function compareIds(a: string, b: string): number {
    const [aMs = 0, aSeq = 0] = a.split("-").map(Number), [bMs = 0, bSeq = 0] = b.split("-").map(Number);
    return aMs - bMs || aSeq - bSeq;
}
