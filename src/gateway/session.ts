import { randomUUID } from "node:crypto";

import Debug from "@yiffy/debug";

import {
    authorizeURL,
    authRequired,
    identifyTimeoutMS,
    maxBufferedBytes,
    maxClientMessagesPerMinute,
    maxConnectionsPerUser,
    maxPrivilegedMessagesPerMinute,
    maxSnapshotIds,
    maxSubscriptions,
    replayBatchSize,
    snapshotChunkSize,
    streamKey,
} from "../config.ts";
import { getSnapshots } from "../db.ts";
import { dispatchFrame, EVENT_TYPES, isNotice, noticeFrame, parseEntry, type StreamItem } from "../events.ts";
import { getRecovery, isActive, notice } from "../recovery.ts";
import redis, { type StreamEntry } from "../redis.ts";

import { describeCredentials, verify, type Credentials, type E621User } from "./auth.ts";
import { StreamCompressor, type CompressionType } from "./compression.ts";
import { compile, FilterError, matches, type CompiledSubscription, type Subscription } from "./filter.ts";
import { isBanned } from "./moderation.ts";
import { parseToken } from "./oauth.ts";
import { removePrivate, updatePrivate, type PrivateEvent, type PrivateMember } from "./private.ts";
import { CloseCodes, compareIds, parseCursor, parseSnapshotRequest, PROTOCOL_VERSION, type ClientMessage, type CloseCode, type IdentifyPayload } from "./protocol.ts";

import type { ServerWebSocket } from "bun";

// one websocket connection. how a connection goes:
//  1. hello is sent on open
//  2. the client sends identify (auth, subscriptions, maybe a cursor) within IDENTIFY_TIMEOUT_MS
//  3. ready is sent. without a cursor it's live right away
//  4. with a cursor it replays everything after it from the stream first, holding live events in a backlog, then
//     sends replay_complete and goes live
// after that the client can change its subscriptions, look up snapshots, and heartbeat. anything wrong closes the
// connection with an error message first, there's no recoverable errors

// set on upgrade in index.ts
export interface SocketData {
    compression: CompressionType | null;
    headerAuth: Credentials | null;
    ip: string;
    session?: Session;
}

// pending: waiting for identify
export type State = "pending" | "replaying" | "live" | "closed";

// e621's privileged level, they get a higher message limit
const PRIVILEGED_LEVEL = 30;

// live events held while replaying, a replay that falls this far behind is closed
const MAX_BACKLOG = 50_000;

// every connection on this gateway
export const sessions = new Set<Session>();
const connectionsByIP = new Map<string, number>();
const connectionsByUser = new Map<number, number>();

// adds to a counter, removing it at 0
function bump<K>(map: Map<K, number>, key: K, by: number): number {
    const value = (map.get(key) ?? 0) + by;
    if (value <= 0) map.delete(key);
    else map.set(key, value);
    return value;
}

// identify's auth, null if it's malformed
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
    // live events that came in while replaying
    private backlog: Array<StreamItem> = [];
    // whether these credentials can poll private events
    private canPrivate = false;
    private compressor: StreamCompressor | null;
    private credentials: Credentials | null = null;
    // identify is async, this stops a second one while the first is still checking auth
    private identifying = false;
    private identifyTimer: Timer;
    // the id of the last thing sent, what heartbeat_ack & replay_complete give back as the cursor to resume from
    private lastSent: string | null = null;
    // when each message in the last minute came in, for the rate limit
    private messageTimes: Array<number> = [];
    // this session's entry in private.ts, while it has private subscriptions
    private privateMember: PrivateMember | null = null;
    private subscriptions: Array<CompiledSubscription> = [];
    // the name from identify
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

    // bytes waiting to go out, compressed or not
    private buffered(): number {
        return this.ws.getBufferedAmount() + (this.compressor?.pending ?? 0);
    }

    // closes the connection and returns null if they're invalid
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

    // notices go to everyone and don't count as sent events
    private deliver(event: StreamItem): boolean {
        if (isNotice(event)) {
            this.lastSent = event.id;
            this.send(noticeFrame(event));
            return false;
        }
        if (!this.subscriptions.some(sub => matches(sub, event))) return false;
        this.lastSent = event.id;
        this.send(dispatchFrame(event));
        return true;
    }

    // private events aren't on the stream, so they have no stream id and aren't replayed. their id is made up in
    // private.ts and they're flagged with private: true
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

        // auth in identify wins over the header
        const credentials = d.auth === undefined ? this.ws.data.headerAuth : parseCredentials(d.auth);
        if (d.auth !== undefined && !credentials) {
            Debug("gateway:auth", `${this.id} from ${this.ws.data.ip} sent malformed auth`);
            this.close(CloseCodes.DECODE_ERROR, "invalid auth");
            return;
        }
        // credentials sent when they aren't required are still checked
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
            // they could have disconnected while that was going
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

        const current = await getRecovery().catch(() => null);
        if (this.is("closed")) return;
        // so clients connecting mid recovery know recovered events are coming
        const recovery = isActive(current) ? notice(current, false) : null;
        if (!cursor) {
            this.state = "live";
            this.send({ op: "ready", d: { session_id: this.id, user: this.user, subscriptions: subs.map(s => s.source), replaying: false, recovery } });
            return;
        }

        // set before anything's awaited, so live events start going into the backlog right away
        this.state = "replaying";
        // a cursor older than the stream's oldest event means some were trimmed, the client is told so in ready
        const [oldest] = await redis.send("XRANGE", [streamKey, "-", "+", "COUNT", "1"]) as Array<StreamEntry>;
        const expired = oldest !== undefined && compareIds(cursor, oldest[0]) < 0;
        this.send({ op: "ready", d: { session_id: this.id, user: this.user, subscriptions: subs.map(s => s.source), replaying: true, cursor_expired: expired, recovery } });
        await this.replay(cursor);
    }

    // typescript can't tell this changes across awaits
    private is(state: State): boolean {
        return this.state === state;
    }

    // the snapshot op. answered in chunks, ids we don't have are null. waits between chunks if the client is behind
    private async lookup(d: unknown): Promise<void> {
        const request = parseSnapshotRequest(d, maxSnapshotIds);
        if (typeof request === "string") {
            this.close(CloseCodes.DECODE_ERROR, request);
            return;
        }
        for (let i = 0; i < request.ids.length; i += snapshotChunkSize) {
            const ids = request.ids.slice(i, i + snapshotChunkSize);
            const found = await getSnapshots(request.resource, ids);
            if (this.is("closed")) return;
            const snapshots: Record<number, Record<string, unknown> | null> = {};
            for (const id of ids) {
                const data = found.get(id);
                snapshots[id] = data ? { id, ...data } : null;
            }
            const done = i + snapshotChunkSize >= request.ids.length;
            this.send({ op: "snapshot", d: { resource: request.resource, nonce: request.nonce, snapshots, done } });
            while (!done && !this.is("closed") && this.buffered() > maxBufferedBytes / 2) await Bun.sleep(50);
        }
    }

    // reads the stream after the cursor in batches, waiting whenever the client's behind. once it's caught up, the
    // backlog is sent (skipping anything the replay already covered) and it goes live. there's no gap between the
    // two since the backlog started filling before the first read
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

    // strings are sent as is (frames from events.ts), objects are stringified
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

    // replaces every subscription. private ones need credentials that can poll them, and register this session with
    // private.ts (or unregister it, when there's none left)
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

    // when the socket's closed, by either side
    cleanup(): void {
        this.state = "closed";
        clearTimeout(this.identifyTimer);
        this.compressor?.close();
        sessions.delete(this);
        if (this.privateMember) removePrivate(this.privateMember);
        bump(connectionsByIP, this.ws.data.ip, -1);
        if (this.user) bump(connectionsByUser, this.user.id, -1);
    }

    // sends an error with the reason, then closes with the same code & reason
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

    // every message counts towards the rate limit, even bad ones
    async handleMessage(message: string | Buffer): Promise<void> {
        if (this.state === "closed") return;
        const now = Date.now();
        this.messageTimes = this.messageTimes.filter(t => now - t < 60_000);
        this.messageTimes.push(now);
        const limit = (this.user?.level ?? 0) >= PRIVILEGED_LEVEL ? maxPrivilegedMessagesPerMinute : maxClientMessagesPerMinute;
        if (this.messageTimes.length > limit) {
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

    // returns whether it was sent now, events held for after a replay don't count
    // called by the hub for every event, pending sessions get nothing
    offer(event: StreamItem): boolean {
        if (this.state === "live") return this.deliver(event) || isNotice(event);
        if (this.state === "replaying") {
            this.backlog.push(event);
            if (this.backlog.length > MAX_BACKLOG) this.close(CloseCodes.SLOW_CONSUMER, "replay too slow");
        }
        return false;
    }

    // every minute from index.ts
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
