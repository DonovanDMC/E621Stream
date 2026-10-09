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
        // 429s are retried by the module itself, honoring Retry-After
        ratelimit: {
            maxRetries: 5,
            onRatelimit: ({ attempt, retryAfter, willRetry }): void => { Debug("e621", `rate limited (attempt ${attempt}, retry after ${retryAfter ?? "?"}s)${willRetry ? "" : ", giving up"}`); },
        },
    });
}

export const e621 = createClient(e621AuthUser, e621AuthKey);

export async function getHTML(url: string, query: Record<string, string | number>): Promise<string> {
    const res = await e621.client.get({ url, query, parseAs: "text" });
    if (!res.response?.ok) throw new UnexpectedResponseError(res.request, res.response, res.error);
    return res.data as string;
}

/** spaces requests out so everything sharing a queue stays under e621's rate limit */
export class RequestQueue {
    private lastRequest = 0;
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly intervalMS: number) {}

    schedule<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.tail.then(async () => {
            const wait = this.lastRequest + this.intervalMS - Date.now();
            if (wait > 0) await Bun.sleep(wait);
            this.lastRequest = Date.now();
            return fn();
        });
        this.tail = run.catch(() => null);
        return run;
    }
}

// the ingester's polling and consumer credential checks each get their own, so a backlog of one can't stall the other
export const ingestQueue = new RequestQueue(e621RequestIntervalMS);
export const authQueue = new RequestQueue(e621AuthRequestIntervalMS);

function statusOf(err: unknown): number | null {
    return err instanceof UnexpectedResponseError ? err.response?.status ?? null : null;
}

async function backoff(attempt: number, reason: string): Promise<void> {
    const ms = Math.min(2 ** attempt * 1000, 60_000) + Math.random() * 1000;
    Debug("e621", `retrying in ${Math.round(ms)}ms (${reason})`);
    await Bun.sleep(ms);
}

/** rate limits and retries a call made with the e621 module */
export async function request<T>(what: string, fn: () => Promise<T>, queue = ingestQueue, retries = 5): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return scrub(await queue.schedule(fn));
        } catch (err) {
            const status = statusOf(err);
            if (status === 401 || status === 403) throw new AuthError(what, status);
            // the module already exhausted its own 429 retries, and anything other than server errors and network
            // failures won't fix itself
            const retryable = !(err instanceof RatelimitError) && (status === null || status >= 500);
            if (!retryable || attempt >= retries) throw err;
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
