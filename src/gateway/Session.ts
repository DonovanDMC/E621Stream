import { randomUUID } from "node:crypto";

import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import GatewayConfig from "../config/GatewayConfig.ts";
import Snapshot from "../db/models/Snapshot.ts";
import User from "../db/models/User.ts";
import { parseToken } from "../http/OAuth.tsx";
import { GATEWAY_CLIENT_NAME_LIMIT, GATEWAY_MAX_BACKLOG } from "../util/Constants.ts";
import { fingerprint } from "../util/HMAC.ts";
import I18n from "../util/I18n.ts";

import { verify, type Credentials, type E621User, type VerifyResult } from "./auth.ts";
import { StreamCompressor, type CompressionType } from "./compression.ts";
import { EVENT_TYPES, PRIVATE_EVENT_TYPES, type StreamEvent, type StreamItem, type StreamNotice } from "./events.ts";
import { compileSubscription, FilterError, filterMatches, type CompiledSubscription } from "./filter.ts";
import { itemsAfter, oldestID } from "./history.ts";
import { isBanned } from "./management.ts";
import { removePrivate, updatePrivate, type PrivateEvent, type PrivateMember } from "./private.ts";
import { ClientOPCodes, CloseCodes, compareIDs, DecodeError, OPCodes, parseCursor, parseSnapshotRequest, PROTOCOL_VERSION, type ClientMessage, type Identify, type SnapshotRequest } from "./protocol.ts";
import { getRecovery } from "./recovery.ts";
import { getSlowMode } from "./slowMode.ts";

import type { ServerWebSocket } from "bun";

export const sessions = [] as Array<Session>;
export const connectionsByIP = new Map<string, number>();
export const connectionsByUser = new Map<number, number>();

export function bumpConnections<T extends "ip" | "user">(type: T, key: T extends "ip" ? string : number, by: number): number {
    const map = type === "ip" ? connectionsByIP : connectionsByUser;
    const value = (map.get(key as never) ?? 0) + by;
    if (value <= 0) map.delete(key as never);
    else map.set(key as never, value);
    return value;
}

export function parseCredentials(value: unknown): Credentials | null {
    if (!value || typeof value !== "object") return null;
    if ("token" in value && typeof value.token === "string") {
        const parsed = parseToken(value.token);
        return parsed ? { token: parsed } : null;
    }
    if ("api_key" in value && typeof value.api_key === "string" && value.api_key !== "" && "username" in value && typeof value.username === "string" && value.username !== "") {
        return { apiKey: value.api_key, username: value.username };
    }

    return null;
}

export interface SocketData {
    compression: CompressionType | null;
    headerAuth: Credentials | null;
    ip: string;
    session?: Session;
    /** The protocol version the client asked for, null if it didn't */
    version: number | null;
}

const describeCredentials = (credentials: Credentials): string => "token" in credentials ? "a token" : `an api key (${credentials.username})`;
const describeUser = (user: E621User): string => `${user.name} #${user.id}`;
const isNotice = (item: StreamItem): item is StreamNotice => "notice" in item && item.notice;

export type SessionState = "pending" | "live" | "replaying" | "closed";
export default class Session {
    private backlog: Array<StreamItem> = [];
    private canPrivate = false;
    private compressor: StreamCompressor | null;
    private credentials: Credentials | null = null;
    private identifying = false;
    private identifyTimer: Timer;
    private lastSeen: string | null = null;
    private messageTimes: Array<number> = [];
    private privateBacklog: Array<PrivateEvent> = [];
    private privateMember: PrivateMember | null = null;
    client: string | null = null;
    readonly connectedAt = new Date();
    readonly id = randomUUID();
    state: SessionState = "pending";
    subscriptions: Array<CompiledSubscription> = [];
    user: E621User | null = null;
    readonly ws: ServerWebSocket<SocketData>;
    constructor(ws: ServerWebSocket<SocketData>) {
        this.ws = ws;
        this.compressor = ws.data.compression ? new StreamCompressor(ws.data.compression) : null;
        bumpConnections("ip", ws.data.ip, 1);
        sessions.push(this);
        this.identifyTimer = setTimeout(() => { void this.close(CloseCodes.NotIdentified, I18n.t("gateway.identifyTimedOut")); }, GatewayConfig.identifyTimeout);
    }

    private buffered(): number {
        return this.ws.getBufferedAmount() + (this.compressor?.pending ?? 0);
    }

    private async compileSubscriptions(input: unknown): Promise<Array<CompiledSubscription> | null> {
        if (!Array.isArray(input) || input.length === 0) {
            await this.close(CloseCodes.InvalidSubscription, I18n.t("gateway.subscriptions.none"));
            return null;
        }

        if (input.length > GatewayConfig.maxSubscriptions) {
            await this.close(CloseCodes.InvalidSubscription, I18n.t("gateway.subscriptions.tooMany", { max: GatewayConfig.maxSubscriptions }));
            return null;
        }

        try {
            return input.map(compileSubscription);
        } catch (err) {
            await this.close(CloseCodes.InvalidSubscription, err instanceof FilterError ? err.message : I18n.t("gateway.subscriptions.invalid"));
            this.debug(`failed to parse subscriptions: ${String(err)}`);
            return null;
        }
    }

    // adds who the session is, so messages only need to say what happened
    private debug(message: string): void {
        Debug("gateway:session", `${this.id} (ip: ${this.ws.data.ip}, user: ${this.user ? describeUser(this.user) : "none"}, client: ${this.client ?? "none"}): ${message}`);
    }

    private async deliver(event: StreamEvent): Promise<boolean> {
        let matches = false;
        for (const sub of this.subscriptions) {
            if (!sub.types.includes(event.type)) continue;
            if (filterMatches(event.type, event.data, sub.filter, event.context)) {
                matches = true;
                break;
            }
        }
        if (!matches) {
            this.lastSeen = event.id;
            return false;
        }
        const success = await this.send({
            op: OPCodes.Dispatch,
            s: event.id,
            t: event.time,
            d: {
                type: event.type,
                recovered: event.recovered,
                private: false,
                data: event.data,
                ...event.context ? { context: event.context } : {},
            },
        });
        if (success) this.lastSeen = event.id;
        else this.debug(`failed to send message ${event.id}`);
        return success;
    }

    private async deliverNotice(event: StreamNotice): Promise<boolean> {
        const op = {
            recovery: OPCodes.Recovery,
            slow_mode: OPCodes.SlowMode,
        }[event.type];
        const dup = structuredClone(event) as unknown as Record<string, unknown>;
        delete dup.type;
        delete dup.id;
        delete dup.time;
        const success = await this.send({
            op,
            s: event.id,
            t: event.time,
            d: {
                notice: true,
                type: event.type,
                data: dup,
            },
        });
        if (success) this.lastSeen = event.id;
        else this.debug(`failed to send notice ${event.id}`);
        return success;
    }

    private async deliverPrivate(event: PrivateEvent): Promise<boolean> {
        if (this.is("pending") || this.is("closed") || !this.privateMember?.privateTypes.includes(event.type)) return false;
        // held until the replay finishes so they don't jump ahead of it
        if (this.is("replaying")) {
            this.privateBacklog.push(event);
            if (this.privateBacklog.length > GATEWAY_MAX_BACKLOG) await this.close(CloseCodes.SlowConsumer, I18n.t("gateway.slow.replay"));
            return false;
        }

        const success = await this.send({
            op: OPCodes.Dispatch,
            s: event.id,
            t: event.time,
            d: {
                type: event.type,
                recovered: event.recovered,
                private: true,
                data: event.data,
            },
        });
        if (!success) this.debug(`failed to send private message ${event.id}`);
        return success;
    }

    private async identify(d: Identify | undefined): Promise<boolean> {
        if (this.isNot("pending") || this.identifying) {
            await this.close(CloseCodes.AlreadyIdentified, I18n.t("gateway.alreadyIdentified"));
            return false;
        }

        this.identifying = true;
        clearTimeout(this.identifyTimer);
        if (!d || typeof d !== "object") {
            await this.close(CloseCodes.DecodeError, I18n.t("gateway.invalidPayload"));
            return false;
        }

        const credentials = d.auth === undefined ? this.ws.data.headerAuth : parseCredentials(d.auth);
        if (d.auth !== undefined && !credentials) {
            this.debug("sent malformed auth");
            await this.close(CloseCodes.DecodeError, I18n.t("gateway.auth.malformed"));
            return false;
        }

        if (GatewayConfig.authRequired && !credentials) {
            this.debug("sent no auth");
            await this.close(CloseCodes.AuthenticationFailed, I18n.t("gateway.auth.required"));
            return false;
        }

        if (credentials) {
            let result: VerifyResult;
            try {
                result = await verify(credentials);
            } catch (err) {
                this.debug(`couldn't verify ${describeCredentials(credentials)}: ${String(err)}`);
                await this.close(CloseCodes.UnknownError, I18n.t("gateway.auth.verifyFailed"));
                return false;
            }

            if (this.is("closed")) return false;
            if (!result.ok) {
                this.debug(`${describeCredentials(credentials)} failed verification: ${result.reason}`);
                await this.close(CloseCodes.AuthenticationFailed, result.reason);
                return false;
            }

            if (await isBanned(result.user.id)) {
                this.debug(`${describeUser(result.user)} tried to connect but is banned`);
                await this.close(CloseCodes.Banned, I18n.t("gateway.auth.banned"));
                return false;
            }

            if (this.is("closed")) return false;
            if (GatewayConfig.maxConnectionsPerUser > 0 && (connectionsByUser.get(result.user.id) ?? 0) >= GatewayConfig.maxConnectionsPerUser) {
                this.debug(`${describeUser(result.user)} tried to connect more than ${GatewayConfig.maxConnectionsPerUser} sessions at a time`);
                await this.close(CloseCodes.TooManyConnections, I18n.t("gateway.tooManyConnections", { max: GatewayConfig.maxConnectionsPerUser }));
                return false;
            }

            this.credentials = credentials;
            this.canPrivate = result.private;
            this.user = result.user;
            bumpConnections("user", result.user.id, 1);
        }

        const subs = await this.compileSubscriptions(d.subscriptions);
        if (!subs) return false;
        let cursor: string | null = null;
        if (d.cursor !== undefined) {
            cursor = parseCursor(d.cursor);
            if (!cursor) {
                await this.close(CloseCodes.InvalidCursor, I18n.t("gateway.invalidCursor"));
                return false;
            }
        }

        if (!(await this.setSubscriptions(subs))) return false;
        if (d.client) {
            if (typeof d.client !== "string") {
                await this.close(CloseCodes.DecodeError, I18n.t("gateway.client.notString"));
                return false;
            }

            if (d.client.length > GATEWAY_CLIENT_NAME_LIMIT) {
                await this.close(CloseCodes.DecodeError, I18n.t("gateway.client.tooLong", { max: GATEWAY_CLIENT_NAME_LIMIT }));
                return false;
            }

            this.client = d.client;
        }

        this.debug(`identified (subscriptions: ${subs.length}${cursor ? `, replaying from ${cursor}` : ""})`);
        const recovery = await getRecovery().catch(() => null);
        const slowMode = await getSlowMode().catch(() => null);
        if (this.is("closed")) return false;

        if (!cursor) {
            this.state = "live";
            await this.send({
                op: OPCodes.Ready,
                d: {
                    session_id: this.id,
                    user: this.user,
                    subscriptions: this.subscriptions.length,
                    replaying: false,
                    recovery,
                    slow_mode: slowMode,
                },
            });
            return true;
        }

        this.state = "replaying";
        const oldest = await oldestID();
        const expired = oldest !== null && compareIDs(cursor, oldest) < 0;
        await this.send({
            op: OPCodes.Ready,
            d: {
                session_id: this.id,
                user: this.user,
                subscriptions: this.subscriptions.length,
                replaying: true,
                cursor_expired: expired,
                recovery,
                slow_mode: slowMode,
            },
        });
        if (this.is("closed")) return false;
        await this.replay(cursor);
        return true;
    }

    private async lookup(d: unknown): Promise<void> {
        let request: SnapshotRequest;
        try {
            request = parseSnapshotRequest(d);
        } catch (err) {
            if (err instanceof DecodeError) {
                await this.close(CloseCodes.DecodeError, err.message);
                this.debug(`sent an invalid snapshot request: ${err.message}`);
                return;
            }

            throw err;
        }

        for (let i = 0; i < request.ids.length; i += GatewayConfig.snapshotChunkSize) {
            const ids = request.ids.slice(i, i + GatewayConfig.snapshotChunkSize);
            const result = await Snapshot.forRequest(request.resource, ids);
            if (this.is("closed")) return;
            const done = i + GatewayConfig.snapshotChunkSize >= request.ids.length;
            await this.send({
                op: OPCodes.Snapshot,
                d: {
                    resource: request.resource,
                    nonce: request.nonce,
                    snapshots: result,
                    done,
                },
            });
            while (!done && !this.is("closed") && this.buffered() > (GatewayConfig.maxBufferedBytes / 2)) await Bun.sleep(50);
        }
    }

    private async replay(cursor: string): Promise<void> {
        let from = cursor;
        let sent = 0;
        for await (const items of itemsAfter(cursor, GatewayConfig.replayBatchSize)) {
            if (this.isNot("replaying")) return;
            for (const event of items) {
                from = event.id;
                if (isNotice(event)) {
                    if (await this.deliverNotice(event)) sent++;
                } else {
                    if (await this.deliver(event)) sent++;
                }
            }
            while (this.is("replaying") && this.buffered() > (GatewayConfig.maxBufferedBytes / 2)) await Bun.sleep(50);
            if (this.isNot("replaying")) return;
        }

        for (const event of this.backlog) {
            if (compareIDs(event.id, from) > 0) {
                if (isNotice(event)) {
                    if (await this.deliverNotice(event)) sent++;
                } else {
                    if (await this.deliver(event)) sent++;
                }
            }
        }
        this.backlog = [];
        if (this.isNot("replaying")) return;
        this.state = "live";
        const privateBacklog = this.privateBacklog;
        this.privateBacklog = [];
        for (const event of privateBacklog) await this.deliverPrivate(event);
        if (this.isNot("live")) return;
        await this.send({
            op: OPCodes.ReplayComplete,
            t: Date.now(),
            d: {
                events: sent,
                cursor: this.lastSeen ?? from,
            },
        });
    }

    private async send(payload: object | string, force = false): Promise<boolean> {
        if (this.is("closed")) return false;
        // -1 = backpressure, 0 = dropped, >0 = bytes sent
        let status: Bun.ServerWebSocketSendStatus = 0;
        const data = typeof payload === "string" ? payload : JSON.stringify(payload);
        if (this.compressor) {
            let comp: Buffer;
            try {
                comp = await this.compressor.compress(data);
            } catch (err) {
                this.debug(`${this.ws.data.compression} compression failed: ${String(err)}`);
                // forced sends come from close, so don't recurse into it
                if (!force) await this.close(CloseCodes.UnknownError, I18n.t("gateway.compressionFailed"));
                return false;
            }
            // already compressed, so skip permessage-deflate
            if (!this.is("closed")) status = this.ws.sendBinary(comp, false);
        } else {
            status = this.ws.sendText(data, true);
        }

        if (status === 0) {
            if (!force) await this.close(CloseCodes.SlowConsumer, I18n.t("gateway.slow.messageDropped"));
            return false;
        }

        if (!force && this.buffered() > GatewayConfig.maxBufferedBytes) {
            await this.close(CloseCodes.SlowConsumer, I18n.t("gateway.slow.consumer"));
            return false;
        }

        return true;
    }

    private async setSubscriptions(subs: Array<CompiledSubscription>): Promise<boolean> {
        const privateTypes = subs.flatMap(sub => sub.privateTypes);
        if (privateTypes.length > 0) {
            if (!this.credentials || !this.user) {
                await this.close(CloseCodes.InvalidSubscription, I18n.t("gateway.subscriptions.privateNeedsAuth", { types: privateTypes.join(", ") }));
                return false;
            }

            if (!this.canPrivate) {
                await this.close(CloseCodes.InvalidSubscription, I18n.t("gateway.subscriptions.privateNotEnabled", { types: privateTypes.join(", "), url: Config.publicURL }));
                return false;
            }
        }

        this.subscriptions = subs;
        if (this.credentials && this.user && this.canPrivate) {
            this.privateMember ??= { credentials: this.credentials, userID: this.user.id, privateTypes, deliverPrivate: this.deliverPrivate.bind(this) };
            this.privateMember.privateTypes = privateTypes;
            updatePrivate(this.privateMember);
        }
        return true;
    }

    cleanup(): void {
        this.state = "closed";
        clearTimeout(this.identifyTimer);
        this.compressor?.close();
        const index = sessions.indexOf(this);
        if (index !== -1) sessions.splice(index, 1);
        if (this.privateMember) removePrivate(this.privateMember);
        bumpConnections("ip", this.ws.data.ip, -1);
        if (this.user) bumpConnections("user", this.user.id, -1);
    }

    async close(code: CloseCodes, reason: string): Promise<void> {
        if (this.is("closed")) return;
        this.debug(`closing: ${code} ${reason}`);
        await this.send({
            op: OPCodes.Error,
            t: Date.now(),
            d: { code, message: reason },
        }, true).catch(() => null);
        this.state = "closed";
        if (this.compressor) setTimeout(() => { this.ws.close(code, reason); }, 50);
        else this.ws.close(code, reason);
    }

    async handleMessage(message: string | Buffer): Promise<void> {
        if (this.is("closed")) return;
        const now = Date.now();
        this.messageTimes = this.messageTimes.filter(t => now - t < 60_000);
        this.messageTimes.push(now);
        const limit = await User.messageLimit(this.user?.id ?? null);
        if (this.messageTimes.length > limit) {
            await this.close(CloseCodes.RateLimited, I18n.t("gateway.rateLimited"));
            return;
        }

        let msg: Partial<ClientMessage> | null;
        try {
            msg = JSON.parse(typeof message === "string" ? message : message.toString("utf8")) as Partial<ClientMessage> | null;
        } catch (err) {
            this.debug(`json parsing failed: ${String(err)}`);
            await this.close(CloseCodes.DecodeError, I18n.t("gateway.decodeFailed"));
            return;
        }

        if (msg === null || typeof msg !== "object" || typeof msg.op !== "string") {
            await this.close(CloseCodes.DecodeError, I18n.t("gateway.invalidPayload"));
            return;
        }

        switch (msg.op) {
            case ClientOPCodes.Identify: {
                await this.identify(msg.d);
                break;
            }

            case ClientOPCodes.Subscribe: {
                if (this.is("pending")) {
                    await this.close(CloseCodes.NotIdentified, I18n.t("gateway.notIdentified"));
                    return;
                }

                const subs = await this.compileSubscriptions(msg.d?.subscriptions);
                if (!subs || !(await this.setSubscriptions(subs))) return;
                await this.send({ op: OPCodes.Subscribed, t: now, d: { subscriptions: this.subscriptions.length } });
                return;
            }

            case ClientOPCodes.Snapshot: {
                if (this.is("pending")) {
                    await this.close(CloseCodes.NotIdentified, I18n.t("gateway.notIdentified"));
                    return;
                }

                await this.lookup(msg.d);
                return;
            }

            case ClientOPCodes.Heartbeat: {
                await this.send({ op: OPCodes.HeartbeatAck, t: now, d: { cursor: this.lastSeen } });
                break;
            }

            default: {
                await this.close(CloseCodes.UnknownOP, I18n.t("gateway.unknownOP", { op: String(msg.op) }));
            }
        }
    }

    async hello(): Promise<boolean> {
        return this.send({
            op: OPCodes.Hello,
            d: {
                version: PROTOCOL_VERSION,
                session_id: this.id,
                identify_timeout_ms: GatewayConfig.identifyTimeout,
                auth_required: GatewayConfig.authRequired,
                compression: this.ws.data.compression,
                events: EVENT_TYPES,
                private_events: PRIVATE_EVENT_TYPES,
            },
        });
    }

    // used due to typescript's inference boundaries being funky
    is(state: SessionState): boolean {
        return this.state === state;
    }

    isNot(state: SessionState): boolean {
        return this.state !== state;
    }

    async offer(event: StreamItem): Promise<boolean> {
        if (this.is("live")) {
            if (isNotice(event)) return this.deliverNotice(event);
            else return this.deliver(event);
        }
        if (this.is("replaying")) {
            this.backlog.push(event);
            if (this.backlog.length > GATEWAY_MAX_BACKLOG) await this.close(CloseCodes.SlowConsumer, I18n.t("gateway.slow.replay"));
        }
        return false;
    }

    async recheckAuth(): Promise<void> {
        if (!this.credentials || this.is("closed")) return;
        let result: VerifyResult;
        try {
            result = await verify(this.credentials);
        } catch (err) {
            // likely e621 being down, keep the session and try again next time
            this.debug(`${describeCredentials(this.credentials)} couldn't be rechecked: ${String(err)}`);
            return;
        }

        if (!result.ok) {
            this.debug(`${describeCredentials(this.credentials)} stopped passing verification: ${result.reason}`);
            await this.close(CloseCodes.AuthenticationExpired, result.reason);
            return;
        }

        if (await isBanned(result.user.id)) {
            this.debug("disconnected for being banned");
            await this.close(CloseCodes.Banned, I18n.t("gateway.auth.banned"));
            return;
        }

        this.canPrivate = result.private;
        if (!result.private && this.privateMember && this.privateMember.privateTypes.length !== 0) {
            await this.close(CloseCodes.InvalidSubscription, I18n.t("gateway.subscriptions.privateDisabled"));
        }
    }

    /** Whether it connected with the gateway token that has this fingerprint */
    usesToken(tokenFingerprint: string): boolean {
        return this.credentials !== null && "token" in this.credentials && fingerprint(this.credentials.token) === tokenFingerprint;
    }
}
