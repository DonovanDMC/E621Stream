export const PROTOCOL_VERSION = 1;

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
} as const;
export type CloseCode = typeof CloseCodes[keyof typeof CloseCodes];

export interface IdentifyPayload {
    /** e621 credentials, can also be sent as `Authorization: Basic <base64 username:api_key>` when connecting */
    auth?: { api_key: string; username: string };
    /** free-form client name, for logging */
    client?: string;
    /** an event id (or a millisecond timestamp) to replay from, exclusive */
    cursor?: string | number;
    subscriptions: Array<unknown>;
}

export type ClientMessage
    = | { d: IdentifyPayload; op: "identify" }
        | { d: { subscriptions: Array<unknown> }; op: "subscribe" }
        | { d?: unknown; op: "heartbeat" };

export function parseCursor(value: unknown): string | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return `${value}-0`;
    if (typeof value !== "string") return null;
    if (/^\d+$/.test(value)) return `${value}-0`;
    return /^\d+-\d+$/.test(value) ? value : null;
}

/** compares two redis stream ids */
export function compareIds(a: string, b: string): number {
    const [aMs = 0, aSeq = 0] = a.split("-").map(Number), [bMs = 0, bSeq = 0] = b.split("-").map(Number);
    return aMs - bMs || aSeq - bSeq;
}
