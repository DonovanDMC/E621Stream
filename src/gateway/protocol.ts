import Config from "../Config.ts";
import { STORED_RESOURCES } from "../ingester/sources.ts";
import { GATEWAY_NONCE_LIMIT } from "../util/Constants.ts";
import I18n from "../util/I18n.ts";

import type { SnapshotResourceType } from "./snapshots.ts";

export const PROTOCOL_VERSION = 2;
// what clients can ask for with ?v=, an old one can stay here for a while after a change
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION];
export enum CloseCodes {
    UnknownError = 4000,
    UnknownOP = 4001,
    DecodeError = 4002,
    NotIdentified = 4003,
    AuthenticationFailed = 4004,
    AlreadyIdentified = 4005,
    InvalidSubscription = 4006,
    InvalidCursor = 4007,
    RateLimited = 4008,
    SlowConsumer = 4009,
    TooManyConnections = 4010,
    AuthenticationExpired = 4011,
    Disconnected = 4012,
    Banned = 4013,
    UnsupportedVersion = 4014,
}

export enum OPCodes {
    Hello = "hello",
    Dispatch = "dispatch",
    Ready = "ready",
    Snapshot = "snapshot",
    Error = "error",
    Recovery = "recovery",
    SlowMode = "slow_mode",
    ReplayComplete = "replay_complete",
    Subscribed = "subscribed",
    HeartbeatAck = "heartbeat_ack",
}

export enum ClientOPCodes {
    Identify = "identify",
    Subscribe = "subscribe",
    Snapshot = "snapshot",
    Heartbeat = "heartbeat",
}

export class DecodeError extends Error {
    override name = "DecodeError";
}

export interface Identify {
    auth?: { api_key: string; username: string } | { token: string };
    client?: string;
    cursor?: string | number;
    subscriptions: Array<unknown>;
}

export function parseCursor(value: unknown): string | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return `${value}-0`;
    if (typeof value !== "string") return null;
    if (/^\d+$/.test(value)) return `${value}-0`;
    return /^\d+-\d+$/.test(value) ? value : null;
}

export function compareIDs(a: string, b: string): number {
    const [aMs = 0, aSeq = 0] = a.split("-").map(Number), [bMs = 0, bSeq = 0] = b.split("-").map(Number);
    return aMs - bMs || aSeq - bSeq;
}

export interface SnapshotRequest {
    ids: Array<number>;
    nonce: string | null;
    resource: SnapshotResourceType;
}

export function parseSnapshotRequest(value: unknown): SnapshotRequest {
    if (!value || typeof value !== "object") throw new DecodeError(I18n.t("gateway.invalidPayload"));
    if (!("resource" in value) || typeof value.resource !== "string" || !STORED_RESOURCES.includes(value.resource as SnapshotResourceType)) throw new DecodeError(I18n.t("gateway.snapshot.unknownResource", { resources: STORED_RESOURCES.join(", ") }));
    if (!("ids" in value) || !Array.isArray(value.ids) || value.ids.length === 0) throw new DecodeError(I18n.t("gateway.snapshot.noIDs"));
    if (value.ids.length > Config.maxSnapshotIDs) throw new DecodeError(I18n.t("gateway.snapshot.tooManyIDs", { max: Config.maxSnapshotIDs }));
    if (!value.ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new DecodeError(I18n.t("gateway.snapshot.invalidIDs"));
    if ("nonce" in value && (typeof value.nonce !== "string" || value.nonce.length > GATEWAY_NONCE_LIMIT)) throw new DecodeError(I18n.t("gateway.snapshot.invalidNonce"));
    return { resource: value.resource as SnapshotResourceType, ids: value.ids as Array<number>, nonce: "nonce" in value ? value.nonce as string : null };
}

interface IdentifyMessage { d: Identify; op: ClientOPCodes.Identify }
interface SubscribeMessage { d: { subscriptions: Array<unknown> }; op: ClientOPCodes.Subscribe }
interface SnapshotMessage { d?: unknown; op: ClientOPCodes.Snapshot }
interface HeartbeatMessage { d?: unknown; op: ClientOPCodes.Heartbeat }
export type ClientMessage = IdentifyMessage | SubscribeMessage | SnapshotMessage | HeartbeatMessage;
