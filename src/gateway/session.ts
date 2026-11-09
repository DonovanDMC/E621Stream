import { randomUUID } from "node:crypto";

import Debug from "@yiffy/debug";

import {
    authRequired,
    identifyTimeoutMS,
    maxBufferedBytes,
    maxClientMessagesPerMinute,
    maxConnectionsPerUser,
    maxSubscriptions,
    replayBatchSize,
    streamKey,
} from "../config.ts";
import { dispatchFrame, EVENT_TYPES, parseEntry, type StreamEvent } from "../events.ts";
import redis, { type StreamEntry } from "../redis.ts";

import { verify, type Credentials, type E621User } from "./auth.ts";
import { StreamCompressor, type CompressionType } from "./compression.ts";
import { compile, FilterError, matches, type CompiledSubscription } from "./filter.ts";
import { CloseCodes, compareIds, parseCursor, PROTOCOL_VERSION, type ClientMessage, type CloseCode, type IdentifyPayload } from "./protocol.ts";

import type { ServerWebSocket } from "bun";

export interface SocketData {
    compression: CompressionType | null;
    /** from the Authorization header, used if identify doesn't include credentials */
    headerAuth: Credentials | null;
    ip: string;
    session?: Session;
}

type State = "pending" | "replaying" | "live" | "closed";

// live events that arrive while a replay is running wait here, past this the consumer is too far behind
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
    const { username, api_key: apiKey } = value as Record<string, unknown>;
    if (typeof username !== "string" || typeof apiKey !== "string" || username === "" || apiKey === "") return null;
    return { username, apiKey };
}

export function connectionCount(ip: string): number {
    return connectionsByIP.get(ip) ?? 0;
}

export class Session {
    private backlog: Array<StreamEvent> = [];
    private compressor: StreamCompressor | null;
    // kept so the check can be redone once the cached result expires
    private credentials: Credentials | null = null;
    private identifying = false;
    private identifyTimer: Timer;
    private lastSent: string | null = null;
    private messageTimes: Array<number> = [];
    private subscriptions: Array<CompiledSubscription> = [];
    client: string | null = null;
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
            this.close(CloseCodes.INVALID_SUBSCRIPTION, "subscriptions must be a non-empty array");
            return null;
        }
        if (input.length > maxSubscriptions) {
            this.close(CloseCodes.INVALID_SUBSCRIPTION, `at most ${maxSubscriptions} subscriptions are allowed`);
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

    private async identify(d: IdentifyPayload | undefined): Promise<void> {
        if (this.state !== "pending" || this.identifying) {
            this.close(CloseCodes.ALREADY_IDENTIFIED, "already identified");
            return;
        }
        this.identifying = true;
        // the timeout is for sending identify, verifying it can take longer when e621 is slow
        clearTimeout(this.identifyTimer);
        if (!d || typeof d !== "object") {
            this.close(CloseCodes.DECODE_ERROR, "identify needs a payload");
            return;
        }

        const credentials = d.auth === undefined ? this.ws.data.headerAuth : parseCredentials(d.auth);
        if (d.auth !== undefined && !credentials) {
            this.close(CloseCodes.DECODE_ERROR, "auth must be { username, api_key }");
            return;
        }
        if (authRequired || credentials) {
            if (!credentials) {
                this.close(CloseCodes.AUTHENTICATION_FAILED, "an e621 username and api key are required");
                return;
            }
            let result: Awaited<ReturnType<typeof verify>>;
            try {
                result = await verify(credentials);
            } catch (err) {
                Debug("gateway:auth", `couldn't verify ${credentials.username}: ${String(err)}`);
                this.close(CloseCodes.UNKNOWN_ERROR, "couldn't reach e621 to verify your credentials, try again later");
                return;
            }
            // the socket can close while the check is in flight
            if (this.is("closed")) return;
            if (!result.ok) {
                this.close(CloseCodes.AUTHENTICATION_FAILED, result.reason);
                return;
            }
            if (maxConnectionsPerUser > 0 && (connectionsByUser.get(result.user.id) ?? 0) >= maxConnectionsPerUser) {
                this.close(CloseCodes.TOO_MANY_CONNECTIONS, `each e621 account is limited to ${maxConnectionsPerUser} connection(s)`);
                return;
            }
            this.credentials = credentials;
            this.user = result.user;
            bump(connectionsByUser, result.user.id, 1);
        }

        const subs = this.compileSubscriptions(d.subscriptions);
        if (!subs) return;
        let cursor: string | null = null;
        if (d.cursor !== undefined) {
            cursor = parseCursor(d.cursor);
            if (!cursor) {
                this.close(CloseCodes.INVALID_CURSOR, "cursor must be an event id or a millisecond timestamp");
                return;
            }
        }

        this.subscriptions = subs;
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

    // state changes across awaits, which control flow narrowing can't see
    private is(state: State): boolean {
        return this.state === state;
    }

    private async replay(cursor: string): Promise<void> {
        let from = cursor;
        let sent = 0;
        for (;;) {
            // exclusive start, the cursor is the last event the client already has
            const entries = await redis.send("XRANGE", [streamKey, `(${from}`, "+", "COUNT", String(replayBatchSize)]) as Array<StreamEntry>;
            if (!this.is("replaying")) return;
            for (const entry of entries) {
                const event = parseEntry(entry);
                from = entry[0];
                if (event && this.deliver(event)) sent++;
            }
            if (entries.length < replayBatchSize) break;
            // don't pile the entire retention window into the socket buffer at once
            while (this.is("replaying") && this.buffered() > maxBufferedBytes / 2) await Bun.sleep(50);
            if (!this.is("replaying")) return;
        }
        // anything that came in live while replaying, minus what the last range already covered
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
            // permessage-deflate, if the client negotiated it
            this.ws.sendText(data, true);
        }
        if (this.buffered() > maxBufferedBytes) this.close(CloseCodes.SLOW_CONSUMER, "too far behind, events are being sent faster than they're read");
    }

    /** called once the socket is gone, however it closed */
    cleanup(): void {
        this.state = "closed";
        clearTimeout(this.identifyTimer);
        this.compressor?.close();
        sessions.delete(this);
        bump(connectionsByIP, this.ws.data.ip, -1);
        if (this.user) bump(connectionsByUser, this.user.id, -1);
    }

    close(code: CloseCode, reason: string): void {
        if (this.state === "closed") return;
        this.send({ op: "error", d: { code, message: reason } });
        this.state = "closed";
        const finish = (): void => { this.ws.close(code, reason); };
        // compressed frames go out async, give the error a moment to flush first
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
            this.close(CloseCodes.DECODE_ERROR, "messages must be valid JSON");
            return;
        }
        if (msg === null || typeof msg !== "object" || typeof msg.op !== "string") {
            this.close(CloseCodes.DECODE_ERROR, "messages must be an object with an op");
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
                if (!subs) return;
                this.subscriptions = subs;
                this.send({ op: "subscribed", d: { subscriptions: subs.map(s => s.source) } });
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

    /** a new live event from the hub */
    offer(event: StreamEvent): void {
        if (this.state === "live") {
            this.deliver(event);
        } else if (this.state === "replaying") {
            this.backlog.push(event);
            if (this.backlog.length > MAX_BACKLOG) this.close(CloseCodes.SLOW_CONSUMER, "replay fell too far behind the live stream");
        }
    }

    /** drops the connection if its credentials stopped working, only asks e621 once the cached check expires */
    async recheckAuth(): Promise<void> {
        if (!this.credentials || this.state === "closed") return;
        // if e621 can't be reached this throws, and the connection is left alone
        const result = await verify(this.credentials);
        if (!result.ok) this.close(CloseCodes.AUTHENTICATION_EXPIRED, result.reason);
    }
}
