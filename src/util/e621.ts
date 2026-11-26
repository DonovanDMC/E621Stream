import { AsyncLocalStorage } from "node:async_hooks";

import Debug from "@yiffy/debug";
import E621, { OAuthClient, RatelimitError, UnexpectedResponseError } from "e621";

import Config from "../config/Config.ts";
import GatewayConfig from "../config/GatewayConfig.ts";
import HTTPConfig from "../config/HTTPConfig.ts";
import IngesterConfig from "../config/IngesterConfig.ts";
import { isRecovering } from "../gateway/recovery.ts";

import { E621_REQUEST_TIMEOUT } from "./Constants.ts";
import { AuthError } from "./errors.ts";
import RequestQueue, { type Scheduler } from "./RequestQueue.ts";
import { scrub } from "./scrub.ts";

import type { Options } from "e621";
import type { PostFormatOptions } from "e621/modules/posts/Format";
import type { OAuthToken } from "e621-openapi";

const postFormat = { mode: "basic" } satisfies PostFormatOptions;

export function createClient(auth: Pick<Options, "authKey" | "authToken" | "authUser">): E621<typeof postFormat> {
    return new E621({
        ...auth,
        baseURL: Config.e621BaseURL,
        requestTimeout: E621_REQUEST_TIMEOUT,
        userAgent: Config.e621UserAgent,
        ratelimit: { retry: false }, // we handle ratelimits ourselves
        defaultPostFormat: postFormat,
    });
}

export type E621Client = ReturnType<typeof createClient>;
export const e621 = createClient({ authUser: Config.e621AuthUser, authKey: Config.e621AuthKey });

function statusOf(err: unknown): number | null {
    return err instanceof UnexpectedResponseError ? err.response?.status ?? null : null;
}

// 2s, 4s, 8s... up to a minute, plus up to a second of jitter
async function backoff(attempt: number, reason: string): Promise<void> {
    const ms = Math.min(2 ** attempt * 1000, 60_000) + Math.random() * 1000;
    Debug("e621", `retrying in ${Math.round(ms)}ms (${reason})`);
    await Bun.sleep(ms);
}

export const ingestQueue = new RequestQueue(Config.e621RequestInterval, true, IngesterConfig.backfillShare);
export const authQueue = new RequestQueue(Config.e621AuthRequestInterval, true);
export const privateQueue = new RequestQueue(GatewayConfig.privateRequestInterval, true);
export const backfillQueue = ingestQueue.background;
export const SENSITIVE_KEYS = ["ip_addr", "creator_ip_addr", "updater_ip_addr", "banner_ip_addr", "last_ip_addr", "email"];

// the queue whose slot the running request holds
const holding = new AsyncLocalStorage<Scheduler>();
const sameQueue = (a: Scheduler | undefined, b: Scheduler): boolean => a !== undefined && (a === b || (a === ingestQueue && b === backfillQueue) || (a === backfillQueue && b === ingestQueue));

export async function request<T>(description: string, fn: () => Promise<T>, queue: Scheduler = isRecovering() ? backfillQueue : ingestQueue, retries = 5): Promise<T> {
    // it'd wait for a slot the caller holds, enough of those at once and nothing in the queue moves again
    if (sameQueue(holding.getStore(), queue)) throw new Error(`${description}: requested from inside another request on the same queue`);
    for (let attempt = 1; ; attempt++) {
        try {
            return scrub(await queue.schedule(async () => holding.run(queue, fn)), SENSITIVE_KEYS);
        } catch (err) {
            const status = statusOf(err);
            if (status === 401 || status === 403) throw new AuthError(description, status);
            if (attempt >= retries) throw err;
            if (status === 429) {
                const retryAfter = err instanceof RatelimitError ? err.retryAfter : null;
                const delay = ((retryAfter ?? 2) ** attempt) * 1000;
                Debug("e621", `${description}: ratelimited, retrying in ${delay}ms`);
                await Bun.sleep(delay);
                continue;
            }
            if (status !== null && status < 500) throw err;
            await backoff(attempt, `${description}: ${status ?? String(err)}`);
        }
    }
}

export function createOAuthClient(token?: OAuthToken, onToken?: (token: OAuthToken | null) => Promise<void>): OAuthClient {
    return new OAuthClient({
        clientId: HTTPConfig.oauthClientID!,
        clientSecret: HTTPConfig.oauthClientSecret!,
        redirectURI: HTTPConfig.oauthRedirectURI,
        baseURL: Config.e621BaseURL,
        userAgent: Config.e621UserAgent,
        requestTimeout: E621_REQUEST_TIMEOUT,
        ratelimit: { retry: false },
        token,
        onToken,
    });
}
