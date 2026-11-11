import Debug from "@yiffy/debug";
import E621, { RatelimitError, UnexpectedResponseError, type Options } from "e621";

import { e621AuthKey, e621AuthUser, e621AuthRequestIntervalMS, e621BaseURL, e621PrivateRequestIntervalMS, e621RequestIntervalMS, e621UserAgent, redisPrefix } from "./config.ts";
import redis from "./redis.ts";

export class AuthError extends Error {
    constructor(what: string, status: number) {
        super(`${what} returned ${status}`);
        this.name = "AuthError";
    }
}

export const hasAuth = Boolean(e621AuthUser && e621AuthKey);

export function createClient(auth: Pick<Options, "authKey" | "authToken" | "authUser"> = {}): E621 {
    return new E621({
        ...auth,
        baseURL: e621BaseURL,
        userAgent: e621UserAgent,
        requestTimeout: 30,
        ratelimit: { retry: false },
    });
}

export const e621 = createClient({ authUser: e621AuthUser, authKey: e621AuthKey });

export async function getHTML(url: string, query: Record<string, string | number>): Promise<string> {
    const res = await e621.client.get({ url, query, parseAs: "text" });
    if (!res.response?.ok) throw new UnexpectedResponseError(res.request, res.response, res.error);
    return res.data as string;
}

const MAX_IN_FLIGHT = 2;

export interface Scheduler { schedule<T>(fn: () => Promise<T>): Promise<T> }

// every process shares one ip, so starts are reserved in redis
const RESERVE = `
local now = tonumber(ARGV[1])
local start = math.max(now, tonumber(redis.call("GET", KEYS[1]) or "0") + tonumber(ARGV[2]))
redis.call("SET", KEYS[1], start, "PX", 60000)
return start
`;
async function reserve(): Promise<number> {
    return Number(await redis.send("EVAL", [RESERVE, "1", `${redisPrefix}:e621:last_request`, String(Date.now()), String(e621RequestIntervalMS)]));
}

export class RequestQueue implements Scheduler {
    private inFlight = 0;
    private lastStart = 0;
    private reserving = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private waiting: Array<{ background: boolean; start(): void }> = [];
    readonly background: Scheduler = { schedule: fn => this.enqueue(fn, true) };
    constructor(private readonly intervalMS: number, private readonly shared = false) {}

    private enqueue<T>(fn: () => Promise<T>, background: boolean): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.waiting.push({
                background,
                start: () => {
                    this.inFlight++;
                    fn().then(resolve, reject).finally(() => {
                        this.inFlight--;
                        this.pump();
                    });
                },
            });
            this.pump();
        });
    }

    private pump(): void {
        if (this.timer || this.reserving || this.waiting.length === 0 || this.inFlight >= MAX_IN_FLIGHT) return;
        const wait = this.lastStart + this.intervalMS - Date.now();
        if (wait > 0) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.pump();
            }, wait);
            return;
        }
        if (!this.shared) {
            this.startNext();
            return;
        }
        this.reserving = true;
        void reserve()
            .then(start => start > Date.now() ? Bun.sleep(start - Date.now()) : undefined)
            // no redis, only this process's requests get spaced out
            .catch(() => null)
            .then(() => {
                this.reserving = false;
                this.startNext();
            });
    }

    private startNext(): void {
        const foreground = this.waiting.findIndex(item => !item.background);
        const [next] = this.waiting.splice(foreground === -1 ? 0 : foreground, 1);
        if (!next) return;
        this.lastStart = Date.now();
        next.start();
        this.pump();
    }

    schedule<T>(fn: () => Promise<T>): Promise<T> {
        return this.enqueue(fn, false);
    }
}

export const ingestQueue = new RequestQueue(e621RequestIntervalMS, true);
export const authQueue = new RequestQueue(e621AuthRequestIntervalMS, true);
export const privateQueue = new RequestQueue(e621PrivateRequestIntervalMS, true);
export const backfillQueue = ingestQueue.background;

function statusOf(err: unknown): number | null {
    return err instanceof UnexpectedResponseError ? err.response?.status ?? null : null;
}

async function backoff(attempt: number, reason: string): Promise<void> {
    const ms = Math.min(2 ** attempt * 1000, 60_000) + Math.random() * 1000;
    Debug("e621", `retrying in ${Math.round(ms)}ms (${reason})`);
    await Bun.sleep(ms);
}

export async function request<T>(what: string, fn: () => Promise<T>, queue: Scheduler = ingestQueue, retries = 5): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return scrub(await queue.schedule(fn));
        } catch (err) {
            const status = statusOf(err);
            if (status === 401 || status === 403) throw new AuthError(what, status);
            if (attempt >= retries) throw err;
            if (status === 429) {
                const retryAfter = err instanceof RatelimitError ? err.retryAfter : null;
                const ms = (retryAfter ?? 2 ** attempt) * 1000;
                Debug("e621", `${what}: rate limited, retrying in ${ms}ms`);
                await Bun.sleep(ms);
                continue;
            }
            if (status !== null && status < 500) throw err;
            await backoff(attempt, `${what}: ${status ?? String(err)}`);
        }
    }
}

// this all ends up public, drop anything that looks private just in case
const SENSITIVE_KEYS = new Set(["ip_addr", "creator_ip_addr", "updater_ip_addr", "email", "last_ip_addr"]);
function scrub<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    return strip(JSON.parse(JSON.stringify(value))) as T;
}

function strip(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) if (!SENSITIVE_KEYS.has(k)) out[k] = strip(v);
        return out;
    }
    return value;
}
