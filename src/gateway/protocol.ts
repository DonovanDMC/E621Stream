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
    auth?: { api_key: string; username: string };
    client?: string;
    subscriptions: Array<unknown>;
}

export type ClientMessage
    = | { d: IdentifyPayload; op: "identify" }
        | { d: { subscriptions: Array<unknown> }; op: "subscribe" }
        | { d?: unknown; op: "heartbeat" };
