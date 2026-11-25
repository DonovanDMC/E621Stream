import { randomUUID } from "node:crypto";

import Debug from "@yiffy/debug";
import { type BunRequest } from "bun";
import { OAuthCallbackError, UnexpectedResponseError } from "e621";

import Config from "../Config.ts";
import OAuthLink from "../db/models/OAuthLink.ts";
import User from "../db/models/User.ts";
import Redis from "../db/Redis.ts";
import { BANNED_LEVEL, GATEWAY_TOKEN_PREFIX, MAX_OAUTH_ATTEMPTS, MAX_OAUTH_PENDING_SECONDS, OAUTH_STATE_COOKIE, SESSION_COOKIE } from "../util/Constants.ts";
import { authQueue, createClient, createOAuthClient, request } from "../util/e621.ts";
import { AuthError } from "../util/errors.ts";
import { cookieSecure, genSessionID } from "../util/util.ts";

import GenericError from "./views/GenericError.tsx";
import { render } from "./Views.ts";

import type { E621User } from "../gateway/auth.ts";
import type { OAuthScope, OAuthToken } from "e621-openapi";

const pendingKey = (state: string): string => `${Config.redisPrefix}oauth:pending:${state}`;
const lockKey = (userID: number): string => `${Config.redisPrefix}oauth:lock:${userID}`;

// only deletes the lock if it's still ours, it could have expired and been taken by someone else
const RELEASE = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;

// only really used as quick validation against obviously bad tokens currently
export function parseToken(value: string): string | null {
    return value.startsWith(GATEWAY_TOKEN_PREFIX) && value.length < 200 ? value : null;
}

async function withLock<T>(userID: number, fn: () => Promise<T>): Promise<T> {
    const key = lockKey(userID);
    const id = randomUUID();
    const until = Date.now() + 15_000;
    while (await Redis.send("SET", [key, id, "NX", "PX", "30000"]) !== "OK") {
        if (Date.now() > until) throw new Error(`timed out waiting for oauth lock for user #${userID}`);
        await Bun.sleep(100);
    }
    try {
        // according to @typescript-eslint/return-await, it's required here
        return await fn();
    } finally {
        await Redis.send("EVAL", [RELEASE, "1", key, id]).catch(() => null);
    }
}

export const PURPOSES = ["login", "upgrade", "downgrade"] as const;
export type LoginPurpose = (typeof PURPOSES)[number];

interface Pending { codeVerifier: string; purpose: LoginPurpose; returnTo: string }

const PURPOSE_SCOPE_MAP = {
    login: ["openid", "profile"],
    upgrade: ["openid", "profile", "full"],
    downgrade: ["openid", "profile"],
} satisfies Record<LoginPurpose, Array<OAuthScope>>;

export async function startAuthorization(req: Bun.BunRequest, ip: string, purpose: LoginPurpose, returnTo: string): Promise<Response | null> {
    const attempts = `${Config.redisPrefix}oauth:${ip}`;
    const count = await Redis.incr(attempts);
    if (count === 1) await Redis.expire(attempts, MAX_OAUTH_PENDING_SECONDS);
    if (count > MAX_OAUTH_ATTEMPTS) return null;

    const scopes = PURPOSE_SCOPE_MAP[purpose];
    const { url, state, codeVerifier } = await createOAuthClient().createAuthorizationURL({ scopes });
    await Redis.set(pendingKey(state), JSON.stringify({ codeVerifier, purpose, returnTo } satisfies Pending), "EX", MAX_OAUTH_PENDING_SECONDS);
    req.cookies.set(OAUTH_STATE_COOKIE, state, {
        maxAge: MAX_OAUTH_PENDING_SECONDS,
        secure: cookieSecure(req),
        httpOnly: true,
        sameSite: "lax",
    });
    return Response.redirect(url, 303);
}

export async function callback(req: BunRequest, ip: string): Promise<Response> {
    if (!Config.e621OAuthEnabled) return render(<GenericError title="Feature Disabled" message="This feature is disabled." />, 503);
    const params = new URL(req.url).searchParams;
    const state = params.get("state") ?? "";
    const storedState = req.cookies.get(OAUTH_STATE_COOKIE);
    req.cookies.delete(OAUTH_STATE_COOKIE);
    if (state === "" || state !== storedState) return render(<GenericError title="Login Failed" message="Invalid state in login" />, 400);
    const pending = await Redis.getdel(pendingKey(state));
    if (pending === null) return render(<GenericError title="Login Failed" message="Invalid state in login" />, 400);
    const { codeVerifier, purpose, returnTo } = JSON.parse(pending) as Pending;
    let token: OAuthToken;
    try {
        token = await request("oauth code exchange", () => createOAuthClient().handleCallback(params, { state, codeVerifier }), authQueue, 2);
    } catch (err) {
        const denied = err instanceof OAuthCallbackError && err.error === "access_denied";
        if (denied) {
            return render(<GenericError title="Login Failed" message="You rejected the authorization." />, 400);
        } else {
            Debug("http:oauth", `code exchange from ${ip} failed: ${String(err)}`);
            return render(<GenericError title="Login Failed" message="Authorization failed, try again later." />, 502);
        }
    }

    const full = token.scope.split(" ").includes("full");
    let result: LookupResult;
    try {
        result = await lookup(token.access_token, full);
    } catch (err) {
        Debug("http:oauth", `Failed to lookup user from ip ${ip}: ${String(err)}`);
        void revoke(token);
        return render(<GenericError title="Login Failed" message="Authorization failed, try again later." />, 502);
    }
    const { banned, user: info } = result;
    if (banned) {
        Debug("http:oauth", `${info.name} (https://e621.net/users/${info.id}) from ${ip} tried to log in, but they're banned`);
        void revoke(token);
        return render(<GenericError title="Login Failed" message="Banned accounts cannot use this service." />, 403);
    }

    const sessionID = genSessionID();
    const { user } = await User.oauthLogin(token, info, ip, sessionID);

    const unusedToken = await withLock(user.id, async () => {
        const previous = await OAuthLink.findBy({ user_id: user.id });
        // expire new token immediately if we'd be unintentionally downgrading the stored token
        if (purpose === "login" && previous?.full) return token;

        const data = await lookup(token.access_token, token.scope.split(" ").includes("full"));
        if (previous) {
            // the old one is revoked, read before the update replaces it
            const replaced = previous.oauthToken;
            await previous.updateFromToken(token, data);
            return replaced;
        } else {
            await OAuthLink.createFromToken(user.id, token, data);
        }
    });
    if (unusedToken) void revoke(unusedToken);
    Debug("http:oauth", `${info.name} (https://e621.net/users/${user.id}) ${purpose === "upgrade" ? "enabled private events" : purpose === "downgrade" ? "disabled private events" : "logged in"} from ${ip}`);

    req.cookies.set(SESSION_COOKIE, sessionID, {
        httpOnly: true,
        secure: cookieSecure(req),
        maxAge: Config.sessionLength * 3600,
    });
    return Response.redirect(returnTo, 303);
}

export interface LookupResult { banned: boolean; user: E621User }
export async function lookup(token: string, full: boolean): Promise<LookupResult> {
    const client = createClient({ authToken: token });
    if (full) {
        const me = await request("users.me", () => client.users.me(), authQueue, 2);
        return {
            banned: me.is_banned,
            user: { id: me.id, level: me.level, level_string: me.level_string, name: me.name },
        };
    }
    const info = await request("oauth userinfo", () => client.doorkeeperOpenidConnectUserinfo.get(), authQueue, 2);
    return {
        banned: info.e621_level <= BANNED_LEVEL,
        user: { id: Number(info.sub), name: info.preferred_username, level: info.e621_level, level_string: info.e621_level_string },
    };
}

export async function revoke(token: OAuthToken): Promise<void> {
    return request("oauth revoke", () => createOAuthClient(token).revoke(), authQueue, 3)
        .catch((err: unknown) => { Debug("http:oauth", `Failed to revoke token: ${String(err)}`); });
}

async function unlink(userID: number, reason: string): Promise<void> {
    const link = await OAuthLink.findBy({ user_id: userID });
    await link?.destroy();
    Debug("http:oauth", `unlinked https://e621.net/users/${userID}: ${reason}`);
}

const REFRESH_CHECK_MS = 60_000;
// refreshed this long before they expire, so what's stored is always usable
const REFRESH_AHEAD_MS = 5 * 60_000;

const isInvalidGrant = (err: unknown): boolean => err instanceof UnexpectedResponseError
    && ((typeof err.error === "object" && err.error !== null && (err.error as { error?: unknown }).error === "invalid_grant") || err.message.includes("invalid_grant"));

/** Swaps the link's tokens for new ones and looks the user up again, it's unlinked if e621 won't refresh it anymore */
async function refreshLink(userID: number): Promise<void> {
    await withLock(userID, async () => {
        const link = await OAuthLink.findBy({ user_id: userID });
        // gone, or another server got to it first
        if (!link || link.expires_at.getTime() - Date.now() > REFRESH_AHEAD_MS) return;
        let token: OAuthToken;
        try {
            token = await request("oauth refresh", () => createOAuthClient(link.oauthToken).refresh(), authQueue, 3);
        } catch (err) {
            if (!isInvalidGrant(err)) throw err;
            await unlink(userID, "refresh token rejected");
            return;
        }
        // saved before the new access token is used, using it revokes the old refresh token
        await link.updateTokens(token);
        let result: LookupResult;
        try {
            result = await lookup(token.access_token, link.full);
        } catch (err) {
            if (!(err instanceof AuthError)) throw err;
            await unlink(userID, "new access token rejected");
            return;
        }
        await link.update({ cached_data: result, checked_at: new Date() });
    });
}

/** Keeps every oauth link refreshed, so they stay usable for as long as e621 allows */
export function startOAuthRefresh(): void {
    let busy = false;
    const run = async (): Promise<void> => {
        if (busy) return;
        busy = true;
        try {
            for (const userID of await OAuthLink.expiringBefore(new Date(Date.now() + REFRESH_AHEAD_MS))) {
                await refreshLink(userID).catch((err: unknown) => { Debug("http:oauth", `couldn't refresh https://e621.net/users/${userID}: ${String(err)}`); });
            }
        } finally {
            busy = false;
        }
    };
    void run().catch((err: unknown) => { Debug("http:oauth", `refresh round failed: ${String(err)}`); });
    setInterval(() => void run().catch((err: unknown) => { Debug("http:oauth", `refresh round failed: ${String(err)}`); }), REFRESH_CHECK_MS);
}
