import { randomUUID } from "node:crypto";

import Debug from "@yiffy/debug";

import {
    authRequired,
    identifyTimeoutMS,
    maxBufferedBytes,
    maxClientMessagesPerMinute,
    maxConnectionsPerUser,
    maxSubscriptions,
} from "../config.ts";
import { dispatchFrame, EVENT_TYPES, type StreamEvent } from "../events.ts";

import { verify, type Credentials, type E621User } from "./auth.ts";
import { compile, FilterError, matches, type CompiledSubscription } from "./filter.ts";
import { CloseCodes, PROTOCOL_VERSION, type ClientMessage, type CloseCode, type IdentifyPayload } from "./protocol.ts";

import type { ServerWebSocket } from "bun";

export interface SocketData {
    headerAuth: Credentials | null;
    ip: string;
    session?: Session;
}

type State = "pending" | "live" | "closed";

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
                events: EVENT_TYPES,
            },
        });
    }

    private buffered(): number {
        return this.ws.getBufferedAmount();
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
            this.close(CloseCodes.DECODE_ERROR, "invalid auth");
            return;
        }
        if (authRequired || credentials) {
            if (!credentials) {
                this.close(CloseCodes.AUTHENTICATION_FAILED, "auth required");
                return;
            }
            let result: Awaited<ReturnType<typeof verify>>;
            try {
                result = await verify(credentials);
            } catch (err) {
                Debug("gateway:auth", `couldn't verify ${credentials.username}: ${String(err)}`);
                this.close(CloseCodes.UNKNOWN_ERROR, "couldn't reach e621");
                return;
            }
            if (this.is("closed")) return;
            if (!result.ok) {
                this.close(CloseCodes.AUTHENTICATION_FAILED, result.reason);
                return;
            }
            if (maxConnectionsPerUser > 0 && (connectionsByUser.get(result.user.id) ?? 0) >= maxConnectionsPerUser) {
                this.close(CloseCodes.TOO_MANY_CONNECTIONS, `too many connections (max ${maxConnectionsPerUser})`);
                return;
            }
            this.credentials = credentials;
            this.user = result.user;
            bump(connectionsByUser, result.user.id, 1);
        }

        const subs = this.compileSubscriptions(d.subscriptions);
        if (!subs) return;

        this.subscriptions = subs;
        this.client = typeof d.client === "string" ? d.client.slice(0, 100) : null;
        Debug("gateway:session", `${this.id} identified from ${this.ws.data.ip} (user: ${this.user ? `${this.user.name} #${this.user.id}` : "none"}, client: ${this.client ?? "unknown"}, ${subs.length} subscription(s))`);

        this.state = "live";
        this.send({ op: "ready", d: { session_id: this.id, user: this.user, subscriptions: subs.map(s => s.source) } });
    }

    // typescript can't tell this changes across awaits
    private is(state: State): boolean {
        return this.state === state;
    }

    private send(payload: object | string): void {
        if (this.state === "closed") return;
        const data = typeof payload === "string" ? payload : JSON.stringify(payload);
        this.ws.sendText(data, true);
        if (this.buffered() > maxBufferedBytes) this.close(CloseCodes.SLOW_CONSUMER, "too far behind, events are being sent faster than they're read");
    }

    cleanup(): void {
        this.state = "closed";
        clearTimeout(this.identifyTimer);
        sessions.delete(this);
        bump(connectionsByIP, this.ws.data.ip, -1);
        if (this.user) bump(connectionsByUser, this.user.id, -1);
    }

    close(code: CloseCode, reason: string): void {
        if (this.state === "closed") return;
        this.send({ op: "error", d: { code, message: reason } });
        this.state = "closed";
        this.ws.close(code, reason);
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

    offer(event: StreamEvent): void {
        if (this.state === "live") this.deliver(event);
    }

    async recheckAuth(): Promise<void> {
        if (!this.credentials || this.state === "closed") return;
        const result = await verify(this.credentials);
        if (!result.ok) this.close(CloseCodes.AUTHENTICATION_EXPIRED, result.reason);
    }
}
