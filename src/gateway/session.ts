import { randomUUID } from "node:crypto";

import Debug from "@yiffy/debug";

import {
    authorizeURL,
    authRequired,
    identifyTimeoutMS,
    maxBufferedBytes,
    maxClientMessagesPerMinute,
    maxConnectionsPerUser,
    maxSnapshotIds,
    maxSubscriptions,
    replayBatchSize,
    streamKey,
} from "../config.ts";
import { getSnapshots } from "../db.ts";
import { dispatchFrame, EVENT_TYPES, parseEntry, type StreamEvent } from "../events.ts";
import redis, { type StreamEntry } from "../redis.ts";

import { describeCredentials, verify, type Credentials, type E621User } from "./auth.ts";
import { StreamCompressor, type CompressionType } from "./compression.ts";
import { compile, FilterError, matches, type CompiledSubscription, type Subscription } from "./filter.ts";
import { isBanned } from "./moderation.ts";
import { parseToken } from "./oauth.ts";
import { removePrivate, updatePrivate, type PrivateEvent, type PrivateMember } from "./private.ts";
import { CloseCodes, compareIds, parseCursor, parseSnapshotRequest, PROTOCOL_VERSION, type ClientMessage, type CloseCode, type IdentifyPayload } from "./protocol.ts";

import type { ServerWebSocket } from "bun";

export interface SocketData {
    compression: CompressionType | null;
    headerAuth: Credentials | null;
    ip: string;
    session?: Session;
}

export type State = "pending" | "replaying" | "live" | "closed";

const MAX_BACKLOG = 50_000;

export const sessions = new Set<Session>();
const connectionsByIP = new Map<string, number>();
const connectionsByUser = new Map<number, number>();

function bump<K>(map: Map<K, number>, key: K, by: number): number {
    const value = (map.get(key) ?? 0) + by;
    if (value <= 0) map.delete(key);
    else map.set(key, value);
    return value;
}

function parseCredentials(value: unknown): Credentials | null {
    if (!value || typeof value !== "object") return null;
    const { username, api_key: apiKey, token } = value as Record<string, unknown>;
    if (token !== undefined) {
        const parsed = parseToken(token);
        return parsed ? { token: parsed } : null;
    }
    if (typeof username !== "string" || typeof apiKey !== "string" || username === "" || apiKey === "") return null;
    return { username, apiKey };
}

export function connectionCount(ip: string): number {
    return connectionsByIP.get(ip) ?? 0;
}

export class Session {
    private backlog: Array<StreamEvent> = [];
    private canPrivate = false;
    private compressor: StreamCompressor | null;
    private credentials: Credentials | null = null;
    private identifying = false;
    private identifyTimer: Timer;
    private lastSent: string | null = null;
    private messageTimes: Array<number> = [];
    private privateMember: PrivateMember | null = null;
    private subscriptions: Array<CompiledSubscription> = [];
    client: string | null = null;
    readonly connectedAt = new Date();
    readonly id = randomUUID();
    state: State = "pending";
    user: E621User | null = null;

    constructor(readonly ws: ServerWebSocket<SocketData>) {
        this.compressor = ws.data.compression ? new StreamCompressor(ws.data.compression) : null;
        bump(connectionsByIP, ws.data.ip, 1);
        sessions.add(this);
        this.identifyTimer = setTimeout(() => { this.close(CloseCodes.NOT_IDENTIFIED, "identify timed out"); }, identifyTimeoutMS);
        this.send({
            op: "hello",
            d: {
                version: PROTOCOL_VERSION,
                session_id: this.id,
                identify_timeout_ms: identifyTimeoutMS,
                auth_required: authRequired,
                compression: ws.data.compression,
                events: EVENT_TYPES,
            },
        });
    }

    private buffered(): number {
        return this.ws.getBufferedAmount() + (this.compressor?.pending ?? 0);
    }

    private compileSubscriptions(input: unknown): Array<CompiledSubscription> | null {
        if (!Array.isArray(input) || input.length === 0) {
            this.close(CloseCodes.INVALID_SUBSCRIPTION, "no subscriptions");
            return null;
        }
        if (input.length > maxSubscriptions) {
            this.close(CloseCodes.INVALID_SUBSCRIPTION, `too many subscriptions (max ${maxSubscriptions})`);
            return null;
        }
        try {
            return input.map(compile);
        } catch (err) {
            this.close(CloseCodes.INVALID_SUBSCRIPTION, err instanceof FilterError ? err.message : "invalid subscription");
            return null;
        }
    }

    private deliver(event: StreamEvent): boolean {
        if (!this.subscriptions.some(sub => matches(sub, event))) return false;
        this.lastSent = event.id;
        this.send(dispatchFrame(event));
        return true;
    }

    private deliverPrivate({ data, id, time, type }: PrivateEvent): void {
        if (this.state === "pending" || this.state === "closed" || !this.privateMember?.privateTypes.has(type)) return;
        this.send({ op: "dispatch", id, type, time, private: true, data });
    }

    private async identify(d: IdentifyPayload | undefined): Promise<void> {
        if (this.state !== "pending" || this.identifying) {
            this.close(CloseCodes.ALREADY_IDENTIFIED, "already identified");
            return;
        }
        this.identifying = true;
        clearTimeout(this.identifyTimer);
        if (!d || typeof d !== "object") {
            this.close(CloseCodes.DECODE_ERROR, "missing payload");
            return;
        }

        const credentials = d.auth === undefined ? this.ws.data.headerAuth : parseCredentials(d.auth);
        if (d.auth !== undefined && !credentials) {
            Debug("gateway:auth", `${this.id} from ${this.ws.data.ip} sent malformed auth`);
            this.close(CloseCodes.DECODE_ERROR, "invalid auth");
            return;
        }
        if (authRequired || credentials) {
            if (!credentials) {
                Debug("gateway:auth", `${this.id} from ${this.ws.data.ip} didn't send any credentials`);
                this.close(CloseCodes.AUTHENTICATION_FAILED, "auth required");
                return;
            }
            let result: Awaited<ReturnType<typeof verify>>;
            try {
                result = await verify(credentials);
            } catch (err) {
                Debug("gateway:auth", `couldn't verify ${describeCredentials(credentials)} from ${this.ws.data.ip}: ${String(err)}`);
                this.close(CloseCodes.UNKNOWN_ERROR, "couldn't reach e621");
                return;
            }
            if (this.is("closed")) return;
            if (!result.ok) {
                Debug("gateway:auth", `${describeCredentials(credentials)} from ${this.ws.data.ip} failed verification: ${result.reason}`);
                this.close(CloseCodes.AUTHENTICATION_FAILED, result.reason);
                return;
            }
            if (await isBanned(result.user.id)) {
                Debug("gateway:auth", `${result.user.name} #${result.user.id} from ${this.ws.data.ip} is banned`);
                this.close(CloseCodes.BANNED, "banned");
                return;
            }
            if (this.is("closed")) return;
            if (maxConnectionsPerUser > 0 && (connectionsByUser.get(result.user.id) ?? 0) >= maxConnectionsPerUser) {
                Debug("gateway:auth", `${result.user.name} #${result.user.id} from ${this.ws.data.ip} is already at ${maxConnectionsPerUser} connection(s)`);
                this.close(CloseCodes.TOO_MANY_CONNECTIONS, `too many connections (max ${maxConnectionsPerUser})`);
                return;
            }
            this.credentials = credentials;
            this.canPrivate = result.private;
            this.user = result.user;
            bump(connectionsByUser, result.user.id, 1);
        }

        const subs = this.compileSubscriptions(d.subscriptions);
        if (!subs) return;
        let cursor: string | null = null;
        if (d.cursor !== undefined) {
            cursor = parseCursor(d.cursor);
            if (!cursor) {
                this.close(CloseCodes.INVALID_CURSOR, "invalid cursor");
                return;
            }
        }

        if (!this.setSubscriptions(subs)) return;
        this.client = typeof d.client === "string" ? d.client.slice(0, 100) : null;
        Debug("gateway:session", `${this.id} identified from ${this.ws.data.ip} (user: ${this.user ? `${this.user.name} #${this.user.id}` : "none"}, client: ${this.client ?? "unknown"}, ${subs.length} subscription(s)${cursor ? `, replaying from ${cursor}` : ""})`);

        if (!cursor) {
            this.state = "live";
            this.send({ op: "ready", d: { session_id: this.id, user: this.user, subscriptions: subs.map(s => s.source), replaying: false } });
            return;
        }

        this.state = "replaying";
        const [oldest] = await redis.send("XRANGE", [streamKey, "-", "+", "COUNT", "1"]) as Array<StreamEntry>;
        const expired = oldest !== undefined && compareIds(cursor, oldest[0]) < 0;
        this.send({ op: "ready", d: { session_id: this.id, user: this.user, subscriptions: subs.map(s => s.source), replaying: true, cursor_expired: expired } });
        await this.replay(cursor);
    }

    // typescript can't tell this changes across awaits
    private is(state: State): boolean {
        return this.state === state;
    }

    private async lookup(d: unknown): Promise<void> {
        const request = parseSnapshotRequest(d, maxSnapshotIds);
        if (typeof request === "string") {
            this.close(CloseCodes.DECODE_ERROR, request);
            return;
        }
        const found = await getSnapshots(request.resource, request.ids);
        if (this.is("closed")) return;
        const snapshots: Record<number, Record<string, unknown> | null> = {};
        for (const id of request.ids) {
            const data = found.get(id);
            snapshots[id] = data ? { id, ...data } : null;
        }
        this.send({ op: "snapshot", d: { resource: request.resource, nonce: request.nonce, snapshots } });
    }

    private async replay(cursor: string): Promise<void> {
        let from = cursor;
        let sent = 0;
        for (;;) {
            const entries = await redis.send("XRANGE", [streamKey, `(${from}`, "+", "COUNT", String(replayBatchSize)]) as Array<StreamEntry>;
            if (!this.is("replaying")) return;
            for (const entry of entries) {
                const event = parseEntry(entry);
                from = entry[0];
                if (event && this.deliver(event)) sent++;
            }
            if (entries.length < replayBatchSize) break;
            while (this.is("replaying") && this.buffered() > maxBufferedBytes / 2) await Bun.sleep(50);
            if (!this.is("replaying")) return;
        }
        for (const event of this.backlog) {
            if (compareIds(event.id, from) > 0 && this.deliver(event)) sent++;
        }
        this.backlog = [];
        if (!this.is("replaying")) return;
        this.state = "live";
        this.send({ op: "replay_complete", d: { events: sent, cursor: this.lastSent ?? from } });
    }

    private send(payload: object | string): void {
        if (this.state === "closed") return;
        const data = typeof payload === "string" ? payload : JSON.stringify(payload);
        if (this.compressor) {
            void this.compressor.compress(data).then((buf) => {
                if (!this.is("closed")) this.ws.sendBinary(buf);
            });
        } else {
            this.ws.sendText(data, true);
        }
        if (this.buffered() > maxBufferedBytes) this.close(CloseCodes.SLOW_CONSUMER, "too slow");
    }

    private setSubscriptions(subs: Array<CompiledSubscription>): boolean {
        const privateTypes = new Set(subs.flatMap(sub => [...sub.privateTypes]));
        if (privateTypes.size !== 0 && (!this.credentials || !this.user)) {
            this.close(CloseCodes.INVALID_SUBSCRIPTION, `${[...privateTypes].join(", ")} require auth`);
            return false;
        }
        if (privateTypes.size !== 0 && !this.canPrivate) {
            this.close(CloseCodes.INVALID_SUBSCRIPTION, `${[...privateTypes].join(", ")} need private events, turn them on at ${authorizeURL}`);
            return false;
        }
        this.subscriptions = subs;
        if (this.credentials && this.user && this.canPrivate) {
            this.privateMember ??= { credentials: this.credentials, userId: this.user.id, privateTypes, deliverPrivate: (event): void => { this.deliverPrivate(event); } };
            this.privateMember.privateTypes = privateTypes;
            updatePrivate(this.privateMember);
        }
        return true;
    }

    activeSubscriptions(): Array<Subscription> {
        return this.subscriptions.map(sub => sub.source);
    }

    cleanup(): void {
        this.state = "closed";
        clearTimeout(this.identifyTimer);
        this.compressor?.close();
        sessions.delete(this);
        if (this.privateMember) removePrivate(this.privateMember);
        bump(connectionsByIP, this.ws.data.ip, -1);
        if (this.user) bump(connectionsByUser, this.user.id, -1);
    }

    close(code: CloseCode, reason: string): void {
        if (this.state === "closed") return;
        Debug("gateway:session", `closing ${this.id} from ${this.ws.data.ip} (user: ${this.user ? `${this.user.name} #${this.user.id}` : "none"}, client: ${this.client ?? "unknown"}): ${code} ${reason}`);
        this.send({ op: "error", d: { code, message: reason } });
        this.state = "closed";
        const finish = (): void => { this.ws.close(code, reason); };
        // compressed frames are sent async, give it a moment
        if (this.compressor) setTimeout(finish, 50);
        else finish();
    }

    async handleMessage(message: string | Buffer): Promise<void> {
        if (this.state === "closed") return;
        const now = Date.now();
        this.messageTimes = this.messageTimes.filter(t => now - t < 60_000);
        this.messageTimes.push(now);
        if (this.messageTimes.length > maxClientMessagesPerMinute) {
            this.close(CloseCodes.RATE_LIMITED, "too many messages");
            return;
        }

        let msg: Partial<ClientMessage> | null;
        try {
            msg = JSON.parse(typeof message === "string" ? message : message.toString("utf8")) as Partial<ClientMessage> | null;
        } catch {
            this.close(CloseCodes.DECODE_ERROR, "invalid json");
            return;
        }
        if (msg === null || typeof msg !== "object" || typeof msg.op !== "string") {
            this.close(CloseCodes.DECODE_ERROR, "missing op");
            return;
        }

        switch (msg.op) {
            case "identify": {
                await this.identify(msg.d);
                break;
            }
            case "subscribe": {
                if (this.state === "pending") {
                    this.close(CloseCodes.NOT_IDENTIFIED, "identify first");
                    return;
                }
                const subs = this.compileSubscriptions((msg.d as { subscriptions?: unknown } | undefined)?.subscriptions);
                if (!subs || !this.setSubscriptions(subs)) return;
                this.send({ op: "subscribed", d: { subscriptions: subs.map(s => s.source) } });
                break;
            }
            case "snapshot": {
                if (this.state === "pending") {
                    this.close(CloseCodes.NOT_IDENTIFIED, "identify first");
                    return;
                }
                await this.lookup(msg.d);
                break;
            }
            case "heartbeat": {
                this.send({ op: "heartbeat_ack", d: { cursor: this.lastSent } });
                break;
            }
            default: {
                this.close(CloseCodes.UNKNOWN_OP, `unknown op "${String(msg.op)}"`);
            }
        }
    }

    offer(event: StreamEvent): void {
        if (this.state === "live") {
            this.deliver(event);
        } else if (this.state === "replaying") {
            this.backlog.push(event);
            if (this.backlog.length > MAX_BACKLOG) this.close(CloseCodes.SLOW_CONSUMER, "replay too slow");
        }
    }

    async recheckAuth(): Promise<void> {
        if (!this.credentials || this.state === "closed") return;
        const result = await verify(this.credentials);
        if (!result.ok) {
            Debug("gateway:auth", `${describeCredentials(this.credentials)} on ${this.id} stopped passing verification: ${result.reason}`);
            this.close(CloseCodes.AUTHENTICATION_EXPIRED, result.reason);
            return;
        }
        this.canPrivate = result.private;
        // authorized again without private events
        if (!result.private && this.privateMember && this.privateMember.privateTypes.size !== 0) {
            this.close(CloseCodes.INVALID_SUBSCRIPTION, `private events were turned off, turn them back on at ${authorizeURL}`);
        }
    }
}
