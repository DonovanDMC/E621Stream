import Debug from "@yiffy/debug";

import { adminSessionHours, adminUserIDs, clientListKey, redisPrefix, trustProxy } from "../config.ts";
import { NAV, NAV_CSS, navHTML } from "../nav.ts";
import redis from "../redis.ts";

import { verify, type E621User } from "./auth.ts";
import { ban, drop, listBans, unban } from "./moderation.ts";
import { PAGE_CSS } from "./status.ts";

import type { ListedClient } from "./presence.ts";

const COOKIE = "e621stream_admin";
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_SECONDS = 600;

type Admin = Pick<E621User, "id" | "name">;

const STATE_LABEL: Record<ListedClient["state"], string> = { pending: "identifying", replaying: "replaying", live: "live" };
const STATE_CLASS: Record<ListedClient["state"], string> = { pending: "dim", replaying: "run", live: "ok" };

const esc = (value: number | string | null | undefined): string => String(value ?? "").replaceAll(/[&<>"']/g, char => `&#${char.codePointAt(0)};`);
const sessionKey = (token: string): string => `${redisPrefix}:admin:${new Bun.CryptoHasher("sha256").update(token).digest("hex")}`;
const optional = (value: string | null | undefined): string | null => value?.trim() ? value.trim() : null;
const redirect = (headers: Record<string, string> = {}): Response => new Response(null, { status: 303, headers: { Location: "/admin", ...headers } });

function token(req: Request): string | null {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
        const [name, ...value] = part.trim().split("=");
        if (name === COOKIE) return value.join("=") || null;
    }
    return null;
}

function cookie(req: Request, value: string, maxAge: number): string {
    const secure = new URL(req.url).protocol === "https:" || (trustProxy && req.headers.get("x-forwarded-proto") === "https");
    return `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

async function current(req: Request, ip: string): Promise<Admin | null> {
    const value = token(req);
    if (!value) return null;
    const raw = await redis.get(sessionKey(value));
    if (raw === null) {
        Debug("gateway:admin", `expired or unknown login from ${ip}`);
        return null;
    }
    const admin = JSON.parse(raw) as Admin;
    // ADMIN_USER_IDS can change while someone's logged in
    if (adminUserIDs.has(admin.id)) return admin;
    Debug("gateway:admin", `${admin.name} #${admin.id} from ${ip} is logged in, but isn't in ADMIN_USER_IDS anymore`);
    await redis.del(sessionKey(value));
    return null;
}

async function form(req: Request): Promise<URLSearchParams> {
    return new URLSearchParams(await req.text().catch(() => ""));
}

function page(body: string, status = 200, headers: Record<string, string> = {}): Response {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Admin - E621Stream</title>
<link rel="icon" href="/favicon.ico">
<style>
${PAGE_CSS}
${NAV_CSS}
form.stack { display: grid; gap: 10px; max-width: 320px; }
form.inline { display: inline; }
input { padding: 6px 8px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font: inherit; }
button { padding: 4px 10px; background: var(--surface); color: var(--heading); border: 1px solid var(--border); border-radius: 4px; font: inherit; cursor: pointer; }
button.bad { color: var(--bad); }
</style>
</head>
<body>
${navHTML(NAV, "/admin")}
<main>
<h1>Admin</h1>
${body}
</main>
</body>
</html>`;
    return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

function loginPage(error?: string, status = 200): Response {
    return page(`${error ? `<p class="bad">${esc(error)}</p>` : ""}
<form class="stack" method="post" action="/admin/login">
<input name="username" placeholder="e621 username" autocomplete="username" required>
<input name="api_key" type="password" placeholder="api key" autocomplete="current-password" required>
<button type="submit">Log in</button>
</form>`, status);
}

function ago(iso: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m ago`;
    return `${Math.floor(seconds / 86_400)}d ${Math.round(seconds % 86_400 / 3600)}h ago`;
}

const button = (action: string, fields: Record<string, string | number>, label: string, confirm?: string): string => `<form class="inline" method="post" action="/admin/${action}"${confirm ? ` data-confirm="${esc(confirm)}" onsubmit="return confirm(this.dataset.confirm)"` : ""}>${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join("")}<button type="submit" class="bad">${label}</button></form>`;

function subscriptions(list: ListedClient["subscriptions"]): string {
    if (list.length === 0) return "<span class=\"dim\">none</span>";
    const items = list.map(sub => `<code>${esc(sub.filter ? JSON.stringify(sub) : sub.type)}</code>`);
    return items.length <= 3 ? items.join("<br>") : `${items.slice(0, 3).join("<br>")}<details><summary>${items.length - 3} more</summary>${items.slice(3).join("<br>")}</details>`;
}

async function adminPage(admin: Admin, notice?: string): Promise<Response> {
    const [lists, bans] = await Promise.all([redis.send("HVALS", [clientListKey]) as Promise<Array<string>>, listBans()]);
    const clients = lists.flatMap(list => JSON.parse(list) as Array<ListedClient>).sort((a, b) => a.connected_at.localeCompare(b.connected_at));
    const clientRows = clients.map(c => `<tr><td>${c.client ? esc(c.client) : "<span class=\"dim\">unnamed</span>"}</td>
<td>${c.user ? `<a href="https://e621.net/users/${c.user_id}">${esc(c.user)}</a>` : "<span class=\"dim\">anonymous</span>"}</td>
<td class="${STATE_CLASS[c.state]}">${STATE_LABEL[c.state]}</td><td>${subscriptions(c.subscriptions)}</td>
<td>${esc(c.ip)}</td><td title="${esc(c.connected_at)}">${ago(c.connected_at)}</td>
<td>${button("drop", { session_id: c.session_id }, "Drop")} ${c.user_id === null || adminUserIDs.has(c.user_id) ? "" : button("ban", { user_id: c.user_id, name: c.user ?? "" }, "Ban", `Ban ${c.user ?? c.user_id}? This drops all of their connections.`)}</td></tr>`).join("");
    const banRows = bans.map(b => `<tr><td><a href="https://e621.net/users/${b.user_id}">${esc(b.name ?? b.user_id)}</a></td><td>${b.reason ? esc(b.reason) : ""}</td><td>${esc(b.banned_by)}</td><td title="${esc(b.banned_at)}">${ago(b.banned_at)}</td><td>${button("unban", { user_id: b.user_id }, "Unban")}</td></tr>`).join("");
    return page(`${notice ? `<p class="ok">${esc(notice)}</p>` : ""}
<div>Logged in as ${esc(admin.name)}. <form class="inline" method="post" action="/admin/logout"><button type="submit">Log out</button></form></div>

<h2>Clients (${clients.length})</h2>
<p class="dim">Dropped clients can still reconnect by hand, ban them to stop that.</p>
${clientRows ? `<div class="table-wrap"><table>
<tr><th>client</th><th>user</th><th>state</th><th>subscriptions</th><th>ip</th><th>connected</th><th></th></tr>
${clientRows}
</table></div>` : "<p>Nobody's connected.</p>"}

<h2>Bans (${bans.length})</h2>
<form class="stack" method="post" action="/admin/ban">
<input name="user_id" placeholder="e621 user id" inputmode="numeric" pattern="[0-9]+" required>
<input name="reason" placeholder="reason (optional)">
<button type="submit" class="bad">Ban</button>
</form>
${banRows ? `<div class="table-wrap"><table>
<tr><th>user</th><th>reason</th><th>by</th><th>banned</th><th></th></tr>
${banRows}
</table></div>` : "<p>Nobody's banned.</p>"}`);
}

async function login(req: Request, ip: string): Promise<Response> {
    const attempts = `${redisPrefix}:admin_attempts:${ip}`;
    const count = await redis.incr(attempts);
    if (count === 1) await redis.expire(attempts, ATTEMPT_WINDOW_SECONDS);
    if (count > MAX_ATTEMPTS) {
        Debug("gateway:admin", `${ip} is over the login limit (${count} attempts)`);
        return loginPage("too many attempts, try again later", 429);
    }

    const body = await form(req);
    const username = body.get("username")?.trim() ?? "", apiKey = body.get("api_key")?.trim() ?? "";
    if (username === "" || apiKey === "") {
        Debug("gateway:admin", `login from ${ip} without a username or api key`);
        return loginPage("username & api key required", 400);
    }

    let result: Awaited<ReturnType<typeof verify>>;
    try {
        result = await verify({ username, apiKey });
    } catch (err) {
        Debug("gateway:admin", `couldn't verify ${username} from ${ip}: ${String(err)}`);
        return loginPage("couldn't reach e621", 503);
    }
    if (!result.ok) {
        Debug("gateway:admin", `failed login for ${username} from ${ip}: ${result.reason} (attempt ${count}/${MAX_ATTEMPTS})`);
        return loginPage("invalid credentials", 401);
    }
    if (!adminUserIDs.has(result.user.id)) {
        Debug("gateway:admin", `${result.user.name} #${result.user.id} tried to log in from ${ip}, but isn't in ADMIN_USER_IDS`);
        return loginPage("not allowed", 403);
    }

    await redis.del(attempts);
    const admin: Admin = { id: result.user.id, name: result.user.name };
    const value = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    await redis.set(sessionKey(value), JSON.stringify(admin), "EX", adminSessionHours * 3600);
    Debug("gateway:admin", `${admin.name} #${admin.id} logged in from ${ip}`);
    return redirect({ "Set-Cookie": cookie(req, value, adminSessionHours * 3600) });
}

async function action(req: Request, admin: Admin, name: string): Promise<Response> {
    const body = await form(req);
    switch (name) {
        case "drop": {
            const sessionId = body.get("session_id") ?? "";
            if (!/^[\da-f-]{36}$/.test(sessionId)) return adminPage(admin);
            await drop(sessionId);
            Debug("gateway:admin", `${admin.name} dropped ${sessionId}`);
            return redirect();
        }
        case "ban": {
            const userId = Number(body.get("user_id"));
            if (!Number.isSafeInteger(userId) || userId <= 0) return adminPage(admin);
            if (adminUserIDs.has(userId)) return adminPage(admin, "admins can't be banned");
            await ban({ user_id: userId, name: optional(body.get("name")), reason: optional(body.get("reason")?.slice(0, 500)), banned_by: admin.name, banned_at: new Date().toISOString() });
            Debug("gateway:admin", `${admin.name} banned #${userId}`);
            return redirect();
        }
        case "unban": {
            const userId = Number(body.get("user_id"));
            if (!Number.isSafeInteger(userId)) return adminPage(admin);
            await unban(userId);
            Debug("gateway:admin", `${admin.name} unbanned #${userId}`);
            return redirect();
        }
        default:
            return new Response("not found", { status: 404 });
    }
}

export async function handleAdmin(req: Request, ip: string): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/admin/login" && req.method === "POST") return login(req, ip);
    if (pathname === "/admin/logout" && req.method === "POST") {
        const value = token(req);
        if (value) await redis.del(sessionKey(value));
        return redirect({ "Set-Cookie": cookie(req, "", 0) });
    }
    const admin = await current(req, ip);
    if (pathname === "/admin" && req.method === "GET") return admin ? adminPage(admin) : loginPage();
    if (req.method === "POST" && pathname.startsWith("/admin/")) {
        if (admin) return action(req, admin, pathname.slice(7));
        Debug("gateway:admin", `${pathname} from ${ip} without a login`);
        return redirect();
    }
    return new Response("not found", { status: 404 });
}
