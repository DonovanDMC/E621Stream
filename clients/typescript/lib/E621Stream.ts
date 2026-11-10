import Emitter from "./Emitter.ts";
import { CloseCodes, type EventType, type PrivateEventType, type StreamEvent, type Subscription } from "./events.ts";

export interface Options {
    /** Your e621 username & api key. */
    auth?: { apiKey: string; username: string };
    /** Shown in the server's logs. */
    client?: string;
    /** An event id or millisecond timestamp to replay from. */
    cursor?: number | string;
    /** Reconnect when the connection drops. */
    reconnect?: boolean;
    subscriptions: Array<Subscription>;
    url?: string;
    /** For runtimes without a global WebSocket (node < 22), the `ws` package works. */
    WebSocket?: typeof WebSocket;
}

export interface Ready {
    /** If the cursor was older than anything still kept. */
    cursor_expired?: boolean;
    replaying: boolean;
    session_id: string;
    subscriptions: Array<Subscription>;
    user: { id: number; level: number; level_string: string; name: string } | null;
}

export interface ClientEvents {
    close: [{ code: number; reason: string; reconnecting: boolean }];
    /** Every event, public or private. */
    dispatch: [StreamEvent];
    error: [Error];
    ready: [Ready];
    reconnecting: [{ attempt: number; delayMS: number }];
    replayComplete: [{ cursor: string | null; events: number }];
    subscribed: [Array<Subscription>];
}

type Listeners = ClientEvents & { [K in EventType | PrivateEventType]: [StreamEvent<K>] };

export class StreamError extends Error {
    constructor(readonly code: number, message: string) {
        super(message);
        this.name = "StreamError";
    }
}

const FATAL = new Set<number>([
    CloseCodes.UNKNOWN_OP,
    CloseCodes.DECODE_ERROR,
    CloseCodes.AUTHENTICATION_FAILED,
    CloseCodes.ALREADY_IDENTIFIED,
    CloseCodes.INVALID_SUBSCRIPTION,
    CloseCodes.INVALID_CURSOR,
    CloseCodes.AUTHENTICATION_EXPIRED,
    CloseCodes.DISCONNECTED,
    CloseCodes.BANNED,
]);
const MAX_DELAY_MS = 60_000;
const HEARTBEAT_MS = 30_000;

/**
 * A connection to E621Stream, see https://e621.stream
 * @example
 * ```ts
 * const stream = new E621Stream({ auth: { username, apiKey }, subscriptions: ["post.create"] });
 * stream.on("post.create", event => console.log(event.data.post.id));
 * stream.connect();
 * ```
 */
export class E621Stream extends Emitter<Listeners> {
    private attempt = 0;
    private closing = false;
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private lastError: StreamError | null = null;
    private lastHeartbeatAck = true;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private socket: WebSocket | null = null;
    cursor: string | null;
    readonly options: Options & { url: string };

    constructor(options: Options) {
        super();
        this.options = { reconnect: true, url: "wss://e621.stream/ws", ...options };
        this.cursor = options.cursor === undefined ? null : String(options.cursor);
    }

    private handle(raw: unknown): void {
        if (typeof raw !== "string") {
            this.emit("error", new Error("compression isn't supported"));
            return;
        }
        const message = JSON.parse(raw) as { d?: unknown; data?: unknown; id?: string; op: string; private?: true; time?: string; type?: string };
        switch (message.op) {
            case "hello": {
                const { auth, client, subscriptions } = this.options;
                this.send({
                    op: "identify",
                    d: {
                        ...(auth ? { auth: { username: auth.username, api_key: auth.apiKey } } : {}),
                        ...(client ? { client } : {}),
                        ...(this.cursor === null ? {} : { cursor: this.cursor }),
                        subscriptions,
                    },
                });
                break;
            }
            case "ready": {
                this.attempt = 0;
                this.emit("ready", message.d as Ready);
                break;
            }
            case "dispatch": {
                const event = { id: message.id, type: message.type, time: message.time, data: message.data, ...(message.private ? { private: true } : {}) } as StreamEvent;
                if (!event.private) this.cursor = event.id;
                this.emit("dispatch", event);
                // typescript can't narrow this
                this.emitUnchecked(event.type, event);
                break;
            }
            case "replay_complete": {
                this.emit("replayComplete", message.d as { cursor: string | null; events: number });
                break;
            }
            case "subscribed": {
                this.emit("subscribed", (message.d as { subscriptions: Array<Subscription> }).subscriptions);
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
        const error = this.lastError;
        this.lastError = null;
        const reconnecting = !this.closing && this.options.reconnect !== false && !FATAL.has(code);
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

    /** Close the connection. */
    close(): void {
        this.closing = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.socket?.close(1000, "closed by client");
    }

    connect(): this {
        if (this.socket) return this;
        this.closing = false;
        // not present before node 22
        const global = (globalThis as Partial<Pick<typeof globalThis, "WebSocket">>).WebSocket;
        const Socket = this.options.WebSocket ?? global;
        if (!Socket) throw new Error("no WebSocket available, pass one with the WebSocket option");
        const socket = this.socket = new Socket(this.options.url);
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
        return this;
    }

    /** Replace the current subscriptions. */
    subscribe(subscriptions: Array<Subscription>): void {
        this.options.subscriptions = subscriptions;
        this.send({ op: "subscribe", d: { subscriptions } });
    }
}
