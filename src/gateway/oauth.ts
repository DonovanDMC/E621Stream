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

const STATE_COOKIE = "e621stream_oauth";
const SESSION_COOKIE = "e621stream_tokens";
const SESSION_HOURS = 12;
const MAX_NAME_LENGTH = 50;
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
const sessionKey = (value: string): string => `${redisPrefix}:oauth:session:${sha256(value)}`;
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
            id bigserial UNIQUE,
            hash text PRIMARY KEY,
            user_id bigint NOT NULL REFERENCES oauth_links (user_id) ON DELETE CASCADE,
            name text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            last_used_at timestamptz
        )
    `;
    // tables made before tokens had names don't have these
    await sql`ALTER TABLE stream_tokens ADD COLUMN IF NOT EXISTS id bigserial UNIQUE`;
    await sql`ALTER TABLE stream_tokens ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'unnamed'`;
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

function page(body: string, status = 200, headers: Headers | Record<string, string> = {}): Response {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tokens - E621Stream</title>
<link rel="icon" href="/favicon.ico">
<style>
${PAGE_CSS}
${NAV_CSS}
form.stack { display: grid; gap: 10px; max-width: 520px; }
form.inline { display: inline; }
form.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
input { padding: 6px 8px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font: inherit; }
button { justify-self: start; padding: 6px 12px; background: var(--surface); color: var(--heading); border: 1px solid var(--border); border-radius: 4px; font: inherit; cursor: pointer; }
button.bad { color: var(--bad); }
pre { overflow-x: auto; }
</style>
</head>
<body>
${navHTML(NAV, "/authorize")}
<main>
<h1>Tokens</h1>
${body}
</main>
</body>
</html>`;
    const res = new Response(html, { status, headers });
    res.headers.set("Content-Type", "text/html; charset=utf-8");
    res.headers.set("Cache-Control", "no-store");
    return res;
}

const redirect = (headers: Headers | Record<string, string> = {}): Response => {
    const res = new Response(null, { status: 303, headers });
    res.headers.set("Location", "/authorize");
    return res;
};

const message = (error?: string, notice?: string): string => `${error ? `<p class="bad">${esc(error)}</p>` : ""}${notice ? `<p class="ok">${esc(notice)}</p>` : ""}`;

function loginPage(error?: string, status = 200): Response {
    return page(`${message(error)}
<p>Log in with your e621 account to make tokens for connecting, instead of using an api key.</p>
<form class="stack" method="post" action="/authorize/login">
<button type="submit">Log in with e621</button>
</form>
<p class="dim">Logging in only lets E621Stream see who you are. Private events can be turned on after.</p>`, status);
}

interface TokenRow { created_at: Date; id: number | string; last_used_at: Date | null; name: string }

const when = (date: Date | null): string => date ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "<span class=\"dim\">never</span>";

const button = (action: string, fields: Record<string, string | number>, label: string, confirm?: string): string => `<form class="inline" method="post" action="/authorize/${action}"${confirm ? ` data-confirm="${esc(confirm)}" onsubmit="return confirm(this.dataset.confirm)"` : ""}>${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join("")}<button type="submit" class="bad">${label}</button></form>`;

interface ManageOptions { created?: { name: string; token: string }; error?: string; notice?: string; status?: number }

async function managePage(link: Link, { created, error, notice, status = 200 }: ManageOptions = {}): Promise<Response> {
    const tokens = await sql<Array<TokenRow>>`SELECT id, name, created_at, last_used_at FROM stream_tokens WHERE user_id = ${link.user_id} ORDER BY created_at`;
    const rows = tokens.map(t => `<tr><td>${esc(t.name)}</td><td>${when(t.created_at)}</td><td>${when(t.last_used_at)}</td><td>${button("tokens/delete", { id: String(t.id) }, "Remove", `Remove ${t.name}? Anything using it gets disconnected.`)}</td></tr>`).join("");
    return page(`<div>Logged in as ${esc(link.name)}. <form class="inline" method="post" action="/authorize/logout"><button type="submit">Log out</button></form></div>
${message(error, notice)}
${created ? `<p class="ok">Made ${esc(created.name)}. It's only shown once, so save it somewhere:</p>
<pre><code>${esc(created.token)}</code></pre>` : ""}

<h2>Tokens (${tokens.length}/${maxTokensPerUser})</h2>
<p class="dim">Send one in <code>identify</code> as <code>auth: { token }</code>, or as an <code>Authorization: Bearer</code> header when connecting. Removing one disconnects anything using it within a minute.</p>
${rows ? `<div class="table-wrap"><table>
<tr><th>name</th><th>created</th><th>last used</th><th></th></tr>
${rows}
</table></div>` : "<p>No tokens yet.</p>"}
${tokens.length < maxTokensPerUser ? `<form class="row" method="post" action="/authorize/tokens">
<input name="name" placeholder="name" maxlength="${MAX_NAME_LENGTH}" required>
<button type="submit">Create</button>
</form>` : ""}

<h2>Private events</h2>
${link.full
    ? `<p class="ok">On, for every token.</p>
<form class="stack" method="post" action="/authorize/private"><input type="hidden" name="private" value="0"><button type="submit">Turn off</button></form>`
    : `<p>Off.</p>
<p class="dim">Private events (dmails & private sets) need full access to your account, which lets E621Stream make any request as you. It's only used to poll your private events.</p>
<form class="stack" method="post" action="/authorize/private"><input type="hidden" name="private" value="1"><button type="submit">Turn on</button></form>`}

<h2>Unlink</h2>
<p class="dim">Removes every token and revokes E621Stream's access. Revoking it in e621's <a href="https://e621.net/applications/authorized">authorized applications</a> does the same.</p>
${button("unlink", {}, "Unlink", "Remove every token and revoke E621Stream's access?")}`, status);
}

function cookieValue(req: Request, name: string): string | null {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
        const [key, ...value] = part.trim().split("=");
        if (key === name) return value.join("=") || null;
    }
    return null;
}

function cookie(req: Request, name: string, value: string, maxAge: number): string {
    const secure = new URL(req.url).protocol === "https:" || (trustProxy && req.headers.get("x-forwarded-proto") === "https");
    // lax, so they're sent when e621 redirects back, but not on posts from other sites
    return `${name}=${value}; Path=/authorize; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

async function loggedIn(req: Request): Promise<Link | null> {
    const value = cookieValue(req, SESSION_COOKIE);
    if (!value) return null;
    const raw = await redis.get(sessionKey(value));
    if (raw === null) return null;
    const link = await getLink((JSON.parse(raw) as { user_id: number }).user_id);
    // unlinked somewhere else, or the refresh token stopped working
    if (!link) await redis.del(sessionKey(value));
    return link;
}

type Purpose = "admin" | "login" | "private";

interface Pending { codeVerifier: string; purpose: Purpose }

/** Sends someone to e621 to authorize, `null` if they've tried too many times. Only turning on private events asks for full access. */
export async function startAuthorization(req: Request, ip: string, purpose: Purpose): Promise<Response | null> {
    const attempts = `${redisPrefix}:oauth_starts:${ip}`;
    const count = await redis.incr(attempts);
    if (count === 1) await redis.expire(attempts, PENDING_SECONDS);
    if (count > MAX_STARTS) return null;

    const scopes: Array<OAuthScope> = purpose === "private" ? ["openid", "profile", "full"] : ["openid", "profile"];
    const { url, state, codeVerifier } = await oauthClient().createAuthorizationURL({ scopes });
    await redis.set(pendingKey(state), JSON.stringify({ codeVerifier, purpose } satisfies Pending), "EX", PENDING_SECONDS);
    return new Response(null, { status: 303, headers: { "Location": url, "Set-Cookie": cookie(req, STATE_COOKIE, state, PENDING_SECONDS) } });
}

const adminError = (error: string, status: number): Response => page(`<p class="bad">${esc(error)}</p>
<p><a href="/admin">Back to the admin panel</a></p>`, status);

async function adminLogin(req: Request, ip: string, token: OAuthToken, clear: string): Promise<Response> {
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
    headers.append("Set-Cookie", clear);
    headers.append("Set-Cookie", setCookie);
    return new Response(`<!DOCTYPE html><meta http-equiv="refresh" content="0;url=/admin"><a href="/admin">Continue to the admin panel</a>`, { headers });
}

async function callback(req: Request, ip: string): Promise<Response> {
    const params = new URL(req.url).searchParams;
    const state = params.get("state") ?? "";
    const clear = cookie(req, STATE_COOKIE, "", 0);
    // the cookie ties the callback to the browser that started it
    if (state === "" || cookieValue(req, STATE_COOKIE) !== state) return loginPage("that login wasn't started here, try again", 400);
    const pending = await redis.send("GETDEL", [pendingKey(state)]) as string | null;
    if (pending === null) return loginPage("that took too long, try again", 400);
    const { codeVerifier, purpose = "login" } = JSON.parse(pending) as Partial<Pending> & { codeVerifier: string };

    let token: OAuthToken;
    try {
        token = await request("oauth code exchange", () => oauthClient().handleCallback(params, { state, codeVerifier }), authQueue, 2);
    } catch (err) {
        const denied = err instanceof OAuthCallbackError && err.error === "access_denied";
        if (!denied) Debug("gateway:oauth", `code exchange from ${ip} failed: ${String(err)}`);
        const [error, status] = denied ? ["you didn't authorize it", 400] : ["couldn't finish with e621, try again", 502];
        return purpose === "admin" ? adminError(error, status) : loginPage(error, status);
    }
    if (purpose === "admin") return adminLogin(req, ip, token, clear);

    const full = scopesOf(token).includes("full");
    let result: Awaited<ReturnType<typeof lookup>>;
    try {
        result = await lookup(token.access_token, full);
    } catch (err) {
        Debug("gateway:oauth", `couldn't look up the user from ${ip}: ${String(err)}`);
        void revoke(token);
        return loginPage("couldn't reach e621, try again", 502);
    }
    const { banned, user } = result;
    if (banned) {
        Debug("gateway:oauth", `${user.name} #${user.id} from ${ip} tried to log in, but they're banned`);
        void revoke(token);
        return loginPage("banned accounts can't connect", 403);
    }

    const unused = await withLock(user.id, async () => {
        const previous = await getLink(user.id);
        // logging in only asks who they are, so it can't replace a link with private events
        if (purpose === "login" && previous?.full) return token;
        await sql`
            INSERT INTO oauth_links (user_id, name, level, level_string, "full", token)
            VALUES (${user.id}, ${user.name}, ${user.level}, ${user.level_string}, ${full}, ${JSON.stringify(token)}::jsonb)
            ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level, level_string = EXCLUDED.level_string,
                banned = false, "full" = EXCLUDED."full", token = EXCLUDED.token, checked_at = now()
        `;
        return previous?.token ?? null;
    });
    if (unused) void revoke(unused);
    Debug("gateway:oauth", `${user.name} #${user.id} ${purpose === "private" ? "turned on private events" : "logged in"} from ${ip}`);

    const session = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    await redis.set(sessionKey(session), JSON.stringify({ user_id: user.id }), "EX", SESSION_HOURS * 3600);
    const headers = new Headers();
    headers.append("Set-Cookie", clear);
    headers.append("Set-Cookie", cookie(req, SESSION_COOKIE, session, SESSION_HOURS * 3600));
    return redirect(headers);
}

// narrowed with a refresh, so it doesn't need another trip to e621
async function disablePrivate(userId: number): Promise<"done" | "failed" | "unlinked"> {
    return withLock(userId, async () => {
        const link = await getLink(userId);
        if (!link) return "unlinked";
        if (!link.full) return "done";
        const oauth = oauthClient(link.token, token => saveToken(userId, token));
        let token: OAuthToken;
        try {
            token = await request("oauth refresh", () => oauth.refresh(["openid", "profile"]), authQueue, 3);
        } catch (err) {
            if (!isInvalidGrant(err)) throw err;
            await unlink(userId, "refresh token was rejected, it was probably revoked");
            return "unlinked";
        }
        if (scopesOf(token).includes("full")) return "failed";
        await sql`UPDATE oauth_links SET "full" = false WHERE user_id = ${userId}`;
        void revoke(link.token);
        return "done";
    });
}

async function action(req: Request, ip: string, link: Link, name: string): Promise<Response> {
    const body = new URLSearchParams(await req.text().catch(() => ""));
    switch (name) {
        case "logout": {
            const value = cookieValue(req, SESSION_COOKIE);
            if (value) await redis.del(sessionKey(value));
            return redirect({ "Set-Cookie": cookie(req, SESSION_COOKIE, "", 0) });
        }
        case "tokens": {
            const tokenName = (body.get("name") ?? "").replaceAll(/\p{Cc}/gu, "").trim();
            if (tokenName === "" || tokenName.length > MAX_NAME_LENGTH) return managePage(link, { error: `names have to be 1-${MAX_NAME_LENGTH} characters`, status: 400 });
            const token = `${TOKEN_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
            // the count is checked in the insert, so two at once can't go over
            const inserted = await sql<Array<{ id: number | string }>>`
                INSERT INTO stream_tokens (hash, user_id, name)
                SELECT ${sha256(token)}, ${link.user_id}, ${tokenName}
                WHERE (SELECT count(*) FROM stream_tokens WHERE user_id = ${link.user_id}) < ${maxTokensPerUser}
                RETURNING id
            `;
            if (inserted.length === 0) return managePage(link, { error: `you can only have ${maxTokensPerUser} tokens`, status: 400 });
            Debug("gateway:oauth", `${link.name} #${link.user_id} made a token from ${ip}`);
            return managePage(link, { created: { name: tokenName, token } });
        }
        case "tokens/delete": {
            const id = Number(body.get("id"));
            if (Number.isSafeInteger(id)) await sql`DELETE FROM stream_tokens WHERE id = ${id} AND user_id = ${link.user_id}`;
            Debug("gateway:oauth", `${link.name} #${link.user_id} removed a token from ${ip}`);
            return redirect();
        }
        case "private": {
            if (body.get("private") === "1") return await startAuthorization(req, ip, "private") ?? managePage(link, { error: "too many attempts, try again later", status: 429 });
            const result = await disablePrivate(link.user_id);
            if (result === "unlinked") return loginPage("your authorization was revoked, log in again");
            Debug("gateway:oauth", `${link.name} #${link.user_id} turned off private events from ${ip}${result === "failed" ? ", but e621 kept full access" : ""}`);
            const current = await getLink(link.user_id) ?? link;
            return result === "done" ? managePage(current, { notice: "private events are off" }) : managePage(current, { error: "e621 didn't drop full access, unlink to turn it off", status: 502 });
        }
        case "unlink": {
            const old = await withLock(link.user_id, async () => {
                const current = await getLink(link.user_id);
                if (current) await unlink(link.user_id, `${link.name} unlinked from ${ip}`);
                return current?.token ?? null;
            });
            if (old) void revoke(old);
            const value = cookieValue(req, SESSION_COOKIE);
            if (value) await redis.del(sessionKey(value));
            return redirect({ "Set-Cookie": cookie(req, SESSION_COOKIE, "", 0) });
        }
        default:
            return new Response("not found", { status: 404 });
    }
}

export async function handleAuthorize(req: Request, ip: string): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/authorize/callback" && req.method === "GET") return callback(req, ip);
    if (pathname === "/authorize/login" && req.method === "POST") return await startAuthorization(req, ip, "login") ?? loginPage("too many attempts, try again later", 429);
    const link = await loggedIn(req);
    if (pathname === "/authorize" && req.method === "GET") return link ? managePage(link) : loginPage();
    if (req.method === "POST" && pathname.startsWith("/authorize/")) return link ? action(req, ip, link, pathname.slice(11)) : redirect();
    return new Response("not found", { status: 404 });
}
