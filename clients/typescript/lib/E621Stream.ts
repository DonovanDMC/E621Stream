import Emitter from "./Emitter.ts";
import { CloseCodes, PROTOCOL_VERSION, type EventType, type PrivateEventType, type StreamEvent, type Subscription } from "./events.ts";

import type { SnapshotDataMap } from "./generated.ts";

export interface Options {
    auth?: { apiKey: string; username: string } | { token: string };
    client?: string;
    cursor?: number | string;
    fetch?: typeof fetch;
    reconnect?: boolean;
    subscriptions: Array<Subscription>;
    url?: string;
    WebSocket?: typeof WebSocket;
}

export interface Recovery {
    done: boolean;
    /** Only once it's done */
    events?: number;
    from: string;
    sources: Array<string>;
    /** Only once it's done */
    status?: "cancelled" | "done" | "failed";
    to: string;
}

export interface SlowMode {
    enabled: boolean;
    scale: number | null;
    since: string;
}

export interface Ready {
    /** When replaying from a cursor older than what's kept */
    cursor_expired?: boolean;
    recovery: Recovery | null;
    replaying: boolean;
    session_id: string;
    slow_mode: { at: string; by: string; scale: number } | null;
    /** How many there are */
    subscriptions: number;
    user: { id: number; level: number; level_string: string; name: string } | null;
}

export type SnapshotResource = keyof SnapshotDataMap;

export interface Snapshot<R extends SnapshotResource> {
    /** The record as it was last seen */
    data: SnapshotDataMap[R];
    id: number;
    resource: R;
    /** A post's change_seq, for everything else when it was last updated (in milliseconds) */
    version: number;
}

export type Snapshots<R extends SnapshotResource> = Record<number, Snapshot<R> | null>;

interface PendingSnapshot { received: Snapshots<SnapshotResource>; reject(err: Error): void; resolve(snapshots: Snapshots<SnapshotResource>): void }

export interface ClientEvents {
    close: [{ code: number; reason: string; reconnecting: boolean }];
    dispatch: [StreamEvent];
    error: [Error];
    ready: [Ready];
    reconnecting: [{ attempt: number; delayMS: number }];
    recovery: [Recovery];
    replayComplete: [{ cursor: string | null; events: number }];
    slowMode: [SlowMode];
    /** How many there are now */
    subscribed: [number];
}

type Listeners = ClientEvents & { [K in EventType | PrivateEventType]: [StreamEvent<K>] };

export class StreamError extends Error {
    constructor(readonly code: number, message: string) {
        super(message);
        this.name = "StreamError";
    }
}

// trying again won't help without changing something first
const FATAL: Array<number> = [
    CloseCodes.UNKNOWN_OP,
    CloseCodes.DECODE_ERROR,
    CloseCodes.AUTHENTICATION_FAILED,
    CloseCodes.ALREADY_IDENTIFIED,
    CloseCodes.INVALID_SUBSCRIPTION,
    CloseCodes.INVALID_CURSOR,
    CloseCodes.AUTHENTICATION_EXPIRED,
    CloseCodes.DISCONNECTED,
    CloseCodes.BANNED,
    CloseCodes.UNSUPPORTED_VERSION,
];
const MAX_DELAY_MS = 60_000;
const HEARTBEAT_MS = 30_000;

export class E621Stream extends Emitter<Listeners> {
    private attempt = 0;
    private closing = false;
    private connecting = false;
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private lastError: StreamError | null = null;
    private lastHeartbeatAck = true;
    private nonce = 0;
    private pendingSnapshots = new Map<string, PendingSnapshot>();
    private ready = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private socket: WebSocket | null = null;
    cursor: string | null;
    readonly options: Options & { url: string };

    constructor(options: Options) {
        super();
        this.options = { reconnect: true, url: "https://e621.stream", ...options };
        this.cursor = options.cursor === undefined ? null : String(options.cursor);
    }

    private handle(raw: unknown): void {
        if (typeof raw !== "string") {
            this.emit("error", new Error("compression isn't supported"));
            return;
        }
        // s is the id of what came from the stream, t when it happened
        const message = JSON.parse(raw) as { d?: unknown; op: string; s?: string; t?: string };
        switch (message.op) {
            case "hello": {
                // a server that ignored ?v= would send messages this can't read
                const { version } = message.d as { version?: number };
                if (version !== PROTOCOL_VERSION) {
                    this.lastError = new StreamError(CloseCodes.UNSUPPORTED_VERSION, `the server speaks protocol version ${String(version)}, this client is for ${PROTOCOL_VERSION}, update it`);
                    this.socket?.close(CloseCodes.UNSUPPORTED_VERSION, "unsupported protocol version");
                    break;
                }
                const { auth, client, subscriptions } = this.options;
                this.send({
                    op: "identify",
                    d: {
                        ...(auth ? { auth: "token" in auth ? { token: auth.token } : { username: auth.username, api_key: auth.apiKey } } : {}),
                        ...(client ? { client } : {}),
                        ...(this.cursor === null ? {} : { cursor: this.cursor }),
                        subscriptions,
                    },
                });
                break;
            }
            case "ready": {
                this.attempt = 0;
                this.ready = true;
                this.emit("ready", message.d as Ready);
                break;
            }
            case "dispatch": {
                const d = message.d as { context?: unknown; data: unknown; private: boolean; recovered: boolean; type: string };
                const event = {
                    id: message.s,
                    type: d.type,
                    time: message.t,
                    data: d.data,
                    ...(d.context ? { context: d.context } : {}),
                    ...(d.private ? { private: true } : {}),
                    ...(d.recovered ? { recovered: true } : {}),
                } as StreamEvent;
                if (!event.private) this.cursor = event.id;
                this.emit("dispatch", event);
                // typescript can't narrow this
                this.emitUnchecked(event.type, event);
                break;
            }
            // notices are on the stream too, so they move the cursor
            case "recovery": {
                if (message.s) this.cursor = message.s;
                this.emit("recovery", (message.d as { data: Recovery }).data);
                break;
            }
            case "slow_mode": {
                if (message.s) this.cursor = message.s;
                this.emit("slowMode", (message.d as { data: SlowMode }).data);
                break;
            }
            case "replay_complete": {
                this.emit("replayComplete", message.d as { cursor: string | null; events: number });
                break;
            }
            case "subscribed": {
                this.emit("subscribed", (message.d as { subscriptions: number }).subscriptions);
                break;
            }
            case "snapshot": {
                const { done, nonce, snapshots } = message.d as { done?: boolean; nonce: string | null; snapshots: Snapshots<SnapshotResource> };
                const pending = nonce === null ? undefined : this.pendingSnapshots.get(nonce);
                if (pending) {
                    Object.assign(pending.received, snapshots);
                    if (done !== false) {
                        this.pendingSnapshots.delete(nonce!);
                        pending.resolve(pending.received);
                    }
                }
                break;
            }
            case "heartbeat_ack": {
                this.lastHeartbeatAck = true;
                break;
            }
            case "error": {
                const { code, message: text } = message.d as { code: number; message: string };
                this.lastError = new StreamError(code, text);
                break;
            }
        }
    }

    private onClose(code: number, reason: string): void {
        this.stopHeartbeat();
        this.socket = null;
        this.ready = false;
        const error = this.lastError;
        this.lastError = null;
        for (const pending of this.pendingSnapshots.values()) pending.reject(error ?? new StreamError(code, reason || "connection closed"));
        this.pendingSnapshots.clear();
        const reconnecting = !this.closing && this.options.reconnect !== false && !FATAL.includes(code);
        if (error) this.emit("error", error);
        this.emit("close", { code, reason: error?.message ?? reason, reconnecting });
        if (!reconnecting) return;
        this.attempt++;
        const base = code === CloseCodes.RATE_LIMITED ? 30_000 : 1000;
        const delayMS = Math.min(MAX_DELAY_MS, base * 2 ** (this.attempt - 1)) * (0.75 + Math.random() * 0.5);
        this.emit("reconnecting", { attempt: this.attempt, delayMS: Math.round(delayMS) });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delayMS);
    }

    private open(Socket: typeof WebSocket, url: string): void {
        const socket = this.socket = new Socket(url);
        socket.addEventListener("open", () => { this.startHeartbeat(); });
        socket.addEventListener("message", (event: MessageEvent) => {
            try {
                this.handle(event.data);
            } catch (err) {
                this.emit("error", err instanceof Error ? err : new Error(String(err)));
            }
        });
        socket.addEventListener("close", (event: CloseEvent) => { this.onClose(event.code, event.reason); });
        socket.addEventListener("error", () => null);
    }

    private send(payload: object): void {
        if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(payload));
    }

    private startHeartbeat(): void {
        this.lastHeartbeatAck = true;
        this.heartbeat = setInterval(() => {
            if (!this.lastHeartbeatAck) {
                this.socket?.close(4999, "heartbeat not acknowledged");
                return;
            }
            this.lastHeartbeatAck = false;
            this.send({ op: "heartbeat" });
        }, HEARTBEAT_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
    }

    private async websocketURL(): Promise<string> {
        const { url } = this.options;
        let websocket: unknown = url;
        if (!/^wss?:\/\//i.test(url)) {
            const res = await (this.options.fetch ?? fetch)(new URL("/info", url));
            if (!res.ok) throw new Error(`${url}/info returned ${res.status}`);
            ({ websocket_url: websocket } = await res.json() as { websocket_url?: unknown });
            if (typeof websocket !== "string") throw new Error(`${url}/info didn't have a websocket url`);
        }
        // so a server that's moved past this version closes with 4014 rather than sending what this can't read
        const versioned = new URL(websocket as string, url);
        versioned.searchParams.set("v", String(PROTOCOL_VERSION));
        return versioned.href;
    }

    close(): void {
        this.closing = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.socket?.close(1000, "closed by client");
    }

    connect(): this {
        if (this.socket || this.connecting) return this;
        this.closing = false;
        const global = (globalThis as Partial<Pick<typeof globalThis, "WebSocket">>).WebSocket;
        const Socket = this.options.WebSocket ?? global;
        if (!Socket) throw new Error("no WebSocket available, pass one with the WebSocket option");
        this.connecting = true;
        this.websocketURL().then((url) => {
            this.connecting = false;
            if (!this.closing) this.open(Socket, url);
        }, (err: unknown) => {
            this.connecting = false;
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
            this.onClose(1006, "couldn't get the websocket url");
        });
        return this;
    }

    async snapshots<R extends SnapshotResource>(resource: R, ids: Array<number>): Promise<Snapshots<R>> {
        if (!this.ready) throw new Error("not ready");
        const nonce = String(++this.nonce);
        return new Promise((resolve, reject) => {
            this.pendingSnapshots.set(nonce, { received: {}, resolve: resolve as PendingSnapshot["resolve"], reject });
            this.send({ op: "snapshot", d: { resource, ids, nonce } });
        });
    }

    subscribe(subscriptions: Array<Subscription>): void {
        this.options.subscriptions = subscriptions;
        this.send({ op: "subscribe", d: { subscriptions } });
    }
}
