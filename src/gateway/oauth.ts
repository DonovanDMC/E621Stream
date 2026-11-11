import Debug from "@yiffy/debug";
import { OAuthCallbackError, OAuthClient, UnexpectedResponseError, type Generated } from "e621";

import {
    adminUserIDs,
    authCacheSeconds,
    e621BaseURL,
    e621UserAgent,
    maxTokensPerUser,
    oauthClientId,
    oauthClientSecret,
    oauthRedirectURI,
    redisPrefix,
    trustProxy,
} from "../config.ts";
import sql from "../db.ts";
import { authQueue, AuthError, createClient, request } from "../e621.ts";
import { NAV, NAV_CSS, navHTML } from "../nav.ts";
import redis from "../redis.ts";

import { createSession } from "./adminSession.ts";
import { PAGE_CSS } from "./status.ts";

import type { E621User, VerifyResult } from "./auth.ts";

type OAuthScope = Generated.Types.OAuthScope;
type OAuthToken = Generated.Types.OAuthToken;

const COOKIE = "e621stream_oauth";
const PENDING_SECONDS = 600;
const MAX_STARTS = 20;
// banned users are blocked
const BLOCKED_LEVEL = 10;
const TOKEN_PREFIX = "e6s_";

interface Link {
    banned: boolean;
    checked_at: Date;
    full: boolean;
    level: number;
    level_string: string;
    name: string;
    token: OAuthToken;
    user_id: number;
}

const esc = (value: number | string): string => String(value).replaceAll(/[&<>"']/g, char => `&#${char.codePointAt(0)};`);
const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const pendingKey = (state: string): string => `${redisPrefix}:oauth:pending:${state}`;
const lockKey = (userId: number): string => `${redisPrefix}:oauth:lock:${userId}`;
const scopesOf = (token: OAuthToken): Array<string> => token.scope.split(" ").filter(Boolean);

export async function migrateOAuth(): Promise<void> {
    await sql`
        CREATE TABLE IF NOT EXISTS oauth_links (
            user_id bigint PRIMARY KEY,
            name text NOT NULL,
            level integer NOT NULL,
            level_string text NOT NULL,
            banned boolean NOT NULL DEFAULT false,
            "full" boolean NOT NULL,
            token jsonb NOT NULL,
            checked_at timestamptz NOT NULL DEFAULT now(),
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `;
    // only hashes are kept, the token itself is shown once
    await sql`
        CREATE TABLE IF NOT EXISTS stream_tokens (
            hash text PRIMARY KEY,
            user_id bigint NOT NULL REFERENCES oauth_links (user_id) ON DELETE CASCADE,
            created_at timestamptz NOT NULL DEFAULT now(),
            last_used_at timestamptz
        )
    `;
    await sql`CREATE INDEX IF NOT EXISTS stream_tokens_user ON stream_tokens (user_id)`;
}

function oauthClient(token?: OAuthToken, onToken?: (token: OAuthToken | null) => Promise<void>): OAuthClient {
    return new OAuthClient({
        clientId: oauthClientId!,
        clientSecret: oauthClientSecret,
        redirectURI: oauthRedirectURI,
        baseURL: e621BaseURL,
        userAgent: e621UserAgent,
        requestTimeout: 30,
        ratelimit: { retry: false },
        token,
        onToken,
    });
}

// the lib only puts the oauth error code in the message
export function isInvalidGrant(err: unknown): boolean {
    if (!(err instanceof UnexpectedResponseError) || err.response?.status !== 400) return false;
    const body = err.error as { error?: unknown } | null;
    return (body !== null && typeof body === "object" && body.error === "invalid_grant") || err.message.includes("invalid_grant");
}

export function parseToken(value: unknown): string | null {
    return typeof value === "string" && value.startsWith(TOKEN_PREFIX) && value.length < 200 ? value : null;
}

const RELEASE = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;
// refresh tokens are single use, so only one gateway can refresh a user's token at a time
async function withLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const key = lockKey(userId), id = crypto.randomUUID(), until = Date.now() + 15_000;
    while (await redis.send("SET", [key, id, "NX", "PX", "30000"]) !== "OK") {
        if (Date.now() > until) throw new Error(`timed out waiting for the oauth lock for #${userId}`);
        await Bun.sleep(100);
    }
    try {
        return await fn();
    } finally {
        await redis.send("EVAL", [RELEASE, "1", key, id]).catch(() => null);
    }
}

async function getLink(userId: number): Promise<Link | null> {
    // bigints come back as strings
    const [row] = await sql<Array<Omit<Link, "user_id"> & { user_id: number | string }>>`SELECT * FROM oauth_links WHERE user_id = ${userId}`;
    return row ? { ...row, user_id: Number(row.user_id) } : null;
}

async function saveToken(userId: number, token: OAuthToken | null): Promise<void> {
    if (token) await sql`UPDATE oauth_links SET token = ${JSON.stringify(token)}::jsonb WHERE user_id = ${userId}`;
}

async function unlink(userId: number, reason: string): Promise<void> {
    await sql`DELETE FROM oauth_links WHERE user_id = ${userId}`;
    Debug("gateway:oauth", `unlinked #${userId}: ${reason}`);
}

async function revoke(token: OAuthToken): Promise<void> {
    await request("oauth revoke", () => oauthClient(token).revoke(), authQueue, 3)
        .catch((err: unknown) => { Debug("gateway:oauth", `couldn't revoke an old token: ${String(err)}`); });
}

/** A current access token for a linked user, refreshed if it's expired. `null` if they aren't linked anymore. */
export async function accessToken(userId: number): Promise<string | null> {
    const link = await getLink(userId);
    if (!link) return null;
    if (!oauthClient(link.token).isExpired) return link.token.access_token;
    return withLock(userId, async () => {
        // another gateway might have just refreshed it
        const current = await getLink(userId);
        if (!current) return null;
        const oauth = oauthClient(current.token, token => saveToken(userId, token));
        if (!oauth.isExpired) return current.token.access_token;
        try {
            return (await request("oauth refresh", () => oauth.refresh(), authQueue, 3)).access_token;
        } catch (err) {
            if (!isInvalidGrant(err)) throw err;
            await unlink(userId, "refresh token was rejected, it was probably revoked");
            return null;
        }
    });
}

async function lookup(token: string, full: boolean): Promise<{ banned: boolean; user: E621User }> {
    const client = createClient({ authToken: token });
    if (full) {
        const me = await request("users.me", () => client.users.me(), authQueue, 2);
        return { banned: me.is_banned, user: { id: me.id, name: me.name, level: me.level, level_string: me.level_string } };
    }
    const info = await request("oauth userinfo", () => client.doorkeeperOpenidConnectUserinfo.get(), authQueue, 2);
    return {
        banned: info.e621_level <= BLOCKED_LEVEL,
        user: { id: Number(info.sub), name: info.preferred_username, level: info.e621_level, level_string: info.e621_level_string },
    };
}

const rechecks = new Map<number, Promise<Link | null>>();
// shared so every session for a user doesn't go to e621 at once
function recheck(userId: number): Promise<Link | null> {
    let pending = rechecks.get(userId);
    if (!pending) {
        pending = (async (): Promise<Link | null> => {
            const link = await getLink(userId);
            if (!link || Date.now() - link.checked_at.getTime() < authCacheSeconds * 1000) return link;
            const token = await accessToken(userId);
            if (!token) return null;
            let result: Awaited<ReturnType<typeof lookup>>;
            try {
                result = await lookup(token, link.full);
            } catch (err) {
                if (!(err instanceof AuthError)) throw err;
                await unlink(userId, "access token was rejected");
                return null;
            }
            const { banned, user } = result;
            await sql`UPDATE oauth_links SET name = ${user.name}, level = ${user.level}, level_string = ${user.level_string}, banned = ${banned}, checked_at = now() WHERE user_id = ${userId}`;
            Debug("gateway:oauth", `checked #${userId} with e621, they're ${user.name}${banned ? " (banned)" : ""}`);
            return { ...link, ...user, banned, user_id: userId };
        })().finally(() => rechecks.delete(userId));
        rechecks.set(userId, pending);
    }
    return pending;
}

export async function verifyToken(token: string): Promise<VerifyResult> {
    const hash = sha256(token);
    const [row] = await sql<Array<{ user_id: number | string }>>`SELECT user_id FROM stream_tokens WHERE hash = ${hash}`;
    if (!row) return { ok: false, reason: "invalid token" };
    const link = await recheck(Number(row.user_id));
    if (!link) return { ok: false, reason: "authorization was revoked" };
    if (link.banned) return { ok: false, reason: "banned" };
    void sql`UPDATE stream_tokens SET last_used_at = now() WHERE hash = ${hash} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 hour')`.catch(() => null);
    return { ok: true, private: link.full, user: { id: link.user_id, name: link.name, level: link.level, level_string: link.level_string } };
}

function page(body: string, status = 200, headers: Record<string, string> = {}): Response {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize - E621Stream</title>
<link rel="icon" href="/favicon.ico">
<style>
${PAGE_CSS}
${NAV_CSS}
form.stack { display: grid; gap: 10px; max-width: 520px; }
label { cursor: pointer; }
button { justify-self: start; padding: 6px 12px; background: var(--surface); color: var(--heading); border: 1px solid var(--border); border-radius: 4px; font: inherit; cursor: pointer; }
pre { overflow-x: auto; }
</style>
</head>
<body>
${navHTML(NAV, "/authorize")}
<main>
<h1>Authorize</h1>
${body}
</main>
</body>
</html>`;
    return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

function startPage(error?: string, status = 200): Response {
    return page(`${error ? `<p class="bad">${esc(error)}</p>` : ""}
<p>Connect with your e621 account instead of an api key. You'll get a token to send in <code>identify</code>.</p>
<form class="stack" method="post" action="/authorize">
<label><input type="checkbox" name="private" value="1"> Private events (dmails & private sets)</label>
<p class="dim">Private events need full access to your account, which lets E621Stream make any request as you. It's only used to poll your private events, leave this off if you don't need them.</p>
<button type="submit">Authorize on e621</button>
</form>
<p class="dim">Authorizing again changes access for all of your tokens. Revoking E621Stream in e621's <a href="https://e621.net/applications/authorized">authorized applications</a> stops all of them.</p>`, status);
}

function cookie(req: Request, value: string, maxAge: number): string {
    const secure = new URL(req.url).protocol === "https:" || (trustProxy && req.headers.get("x-forwarded-proto") === "https");
    // lax, so it's sent when e621 redirects back
    return `${COOKIE}=${value}; Path=/authorize; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function cookieValue(req: Request): string | null {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
        const [name, ...value] = part.trim().split("=");
        if (name === COOKIE) return value.join("=") || null;
    }
    return null;
}

type Purpose = "admin" | "link";

interface Pending { codeVerifier: string; purpose: Purpose }

/** Sends someone to e621 to authorize, `null` if they've tried too many times. Admin logins only need to know who they are. */
export async function startAuthorization(req: Request, ip: string, purpose: Purpose): Promise<Response | null> {
    const attempts = `${redisPrefix}:oauth_starts:${ip}`;
    const count = await redis.incr(attempts);
    if (count === 1) await redis.expire(attempts, PENDING_SECONDS);
    if (count > MAX_STARTS) return null;

    let scopes: Array<OAuthScope> = ["openid", "profile"];
    if (purpose === "link" && new URLSearchParams(await req.text().catch(() => "")).get("private") === "1") scopes = [...scopes, "full"];
    const { url, state, codeVerifier } = await oauthClient().createAuthorizationURL({ scopes });
    await redis.set(pendingKey(state), JSON.stringify({ codeVerifier, purpose } satisfies Pending), "EX", PENDING_SECONDS);
    return new Response(null, { status: 303, headers: { "Location": url, "Set-Cookie": cookie(req, state, PENDING_SECONDS) } });
}

const adminError = (message: string, status: number): Response => page(`<p class="bad">${esc(message)}</p>
<p><a href="/admin">Back to the admin panel</a></p>`, status);

async function adminLogin(req: Request, ip: string, token: OAuthToken, clear: Record<string, string>): Promise<Response> {
    let user: E621User;
    try {
        ({ user } = await lookup(token.access_token, false));
    } catch (err) {
        Debug("gateway:admin", `couldn't look up an oauth login from ${ip}: ${String(err)}`);
        return adminError("couldn't reach e621, try again", 502);
    } finally {
        // it's only needed to see who they are
        void revoke(token);
    }
    if (!adminUserIDs.has(user.id)) {
        Debug("gateway:admin", `${user.name} #${user.id} tried to log in with oauth from ${ip}, but isn't in ADMIN_USER_IDS`);
        return adminError("you're not allowed in the admin panel", 403);
    }
    const setCookie = await createSession(req, { id: user.id, name: user.name });
    Debug("gateway:admin", `${user.name} #${user.id} logged in with oauth from ${ip}`);
    // the admin cookie is strict, so it'd be left off a redirect that started on e621
    const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    headers.append("Set-Cookie", clear["Set-Cookie"]!);
    headers.append("Set-Cookie", setCookie);
    return new Response(`<!DOCTYPE html><meta http-equiv="refresh" content="0;url=/admin"><a href="/admin">Continue to the admin panel</a>`, { headers });
}

async function callback(req: Request, ip: string): Promise<Response> {
    const params = new URL(req.url).searchParams;
    const state = params.get("state") ?? "";
    const clear = { "Set-Cookie": cookie(req, "", 0) };
    // the cookie ties the callback to the browser that started it
    if (state === "" || cookieValue(req) !== state) return startPage("that authorization wasn't started here, try again", 400);
    const pending = await redis.send("GETDEL", [pendingKey(state)]) as string | null;
    if (pending === null) return startPage("that took too long, try again", 400);
    const { codeVerifier, purpose = "link" } = JSON.parse(pending) as Partial<Pending> & { codeVerifier: string };

    let token: OAuthToken;
    try {
        token = await request("oauth code exchange", () => oauthClient().handleCallback(params, { state, codeVerifier }), authQueue, 2);
    } catch (err) {
        const denied = err instanceof OAuthCallbackError && err.error === "access_denied";
        if (!denied) Debug("gateway:oauth", `code exchange from ${ip} failed: ${String(err)}`);
        const [message, status] = denied ? ["you didn't authorize it", 400] : ["couldn't finish authorizing with e621, try again", 502];
        return purpose === "admin" ? adminError(message, status) : startPage(message, status);
    }
    if (purpose === "admin") return adminLogin(req, ip, token, clear);

    const full = scopesOf(token).includes("full");
    let result: Awaited<ReturnType<typeof lookup>>;
    try {
        result = await lookup(token.access_token, full);
    } catch (err) {
        Debug("gateway:oauth", `couldn't look up the user from ${ip}: ${String(err)}`);
        await revoke(token);
        return startPage("couldn't reach e621, try again", 502);
    }
    const { banned, user } = result;
    if (banned) {
        Debug("gateway:oauth", `${user.name} #${user.id} from ${ip} tried to authorize, but they're banned`);
        await revoke(token);
        return startPage("banned accounts can't connect", 403);
    }

    const streamToken = `${TOKEN_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const old = await withLock(user.id, async () => {
        const previous = await getLink(user.id);
        await sql.begin(async (tx) => {
            await tx`
                INSERT INTO oauth_links (user_id, name, level, level_string, "full", token)
                VALUES (${user.id}, ${user.name}, ${user.level}, ${user.level_string}, ${full}, ${JSON.stringify(token)}::jsonb)
                ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level, level_string = EXCLUDED.level_string,
                    banned = false, "full" = EXCLUDED."full", token = EXCLUDED.token, checked_at = now()
            `;
            await tx`INSERT INTO stream_tokens (hash, user_id) VALUES (${sha256(streamToken)}, ${user.id})`;
            await tx`
                DELETE FROM stream_tokens WHERE user_id = ${user.id} AND hash NOT IN (
                    SELECT hash FROM stream_tokens WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT ${maxTokensPerUser}
                )
            `;
        });
        return previous?.token ?? null;
    });
    // otherwise downgrading would leave the full access token valid
    if (old) await revoke(old);
    Debug("gateway:oauth", `${user.name} #${user.id} authorized from ${ip}${full ? " with private events" : ""}`);

    return page(`<p class="ok">Linked ${esc(user.name)}${full ? ", with private events" : ""}.</p>
<p>Here's your token. It's only shown once, so save it somewhere:</p>
<pre><code>${esc(streamToken)}</code></pre>
<p>Send it in <code>identify</code> as <code>auth: { token }</code>, or as an <code>Authorization: Bearer</code> header when connecting. Your older tokens still work too, up to ${maxTokensPerUser} of them.</p>`, 200, clear);
}

export async function handleAuthorize(req: Request, ip: string): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/authorize" && req.method === "GET") return startPage();
    if (pathname === "/authorize" && req.method === "POST") return await startAuthorization(req, ip, "link") ?? startPage("too many attempts, try again later", 429);
    if (pathname === "/authorize/callback" && req.method === "GET") return callback(req, ip);
    return new Response("not found", { status: 404 });
}
