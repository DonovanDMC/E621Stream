import Debug from "@yiffy/debug";
import E621, { RatelimitError, UnexpectedResponseError } from "e621";

import { e621AuthKey, e621AuthUser, e621AuthRequestIntervalMS, e621BaseURL, e621RequestIntervalMS, e621UserAgent } from "./config.ts";

export class AuthError extends Error {
    constructor(what: string, status: number) {
        super(`${what} returned ${status}`);
        this.name = "AuthError";
    }
}

export const hasAuth = Boolean(e621AuthUser && e621AuthKey);

export function createClient(authUser?: string, authKey?: string): E621 {
    return new E621({
        authUser,
        authKey,
        baseURL: e621BaseURL,
        userAgent: e621UserAgent,
        requestTimeout: 30,
        ratelimit: { retry: false },
    });
}

export const e621 = createClient(e621AuthUser, e621AuthKey);

export async function getHTML(url: string, query: Record<string, string | number>): Promise<string> {
    const res = await e621.client.get({ url, query, parseAs: "text" });
    if (!res.response?.ok) throw new UnexpectedResponseError(res.request, res.response, res.error);
    return res.data as string;
}

const MAX_IN_FLIGHT = 2;

export interface Scheduler { schedule<T>(fn: () => Promise<T>): Promise<T> }

/**
 * spaces request starts out so everything sharing a queue stays under e621's rate limit. requests don't wait for the
 * previous one to finish, a response takes longer than the interval so that would make it the limit instead
 */
export class RequestQueue implements Scheduler {
    private inFlight = 0;
    private lastStart = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private waiting: Array<{ background: boolean; start(): void }> = [];
    /** the same queue, for work that should only get the slots nothing else wants */
    readonly background: Scheduler = { schedule: fn => this.enqueue(fn, true) };
    constructor(private readonly intervalMS: number) {}

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
        // when the connection is slow, requests sent apart can still arrive together, this caps how many can
        if (this.timer || this.waiting.length === 0 || this.inFlight >= MAX_IN_FLIGHT) return;
        const wait = this.lastStart + this.intervalMS - Date.now();
        if (wait > 0) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.pump();
            }, wait);
            return;
        }
        const foreground = this.waiting.findIndex(item => !item.background);
        const [next] = this.waiting.splice(foreground === -1 ? 0 : foreground, 1);
        this.lastStart = Date.now();
        next!.start();
        this.pump();
    }

    schedule<T>(fn: () => Promise<T>): Promise<T> {
        return this.enqueue(fn, false);
    }
}

// the ingester's polling and consumer credential checks each get their own, so a backlog of one can't stall the other.
// the backfill shares the ingester's, in the gaps between polls
export const ingestQueue = new RequestQueue(e621RequestIntervalMS);
export const authQueue = new RequestQueue(e621AuthRequestIntervalMS);
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
