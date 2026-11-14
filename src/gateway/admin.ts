import Debug from "@yiffy/debug";

import { adminUserIDs, clientListKey, oauthEnabled, redisPrefix, retentionHours } from "../config.ts";
import { RECOVERABLE } from "../ingester/recovery.ts";
import { NAV, NAV_CSS, navHTML } from "../nav.ts";
import { cancelRecovery, getRecovery, isActive, requestRecovery, type Recovery } from "../recovery.ts";
import redis from "../redis.ts";

import { createSession, sessionCookie, sessionKey, sessionToken, type Admin } from "./adminSession.ts";
import { verify } from "./auth.ts";
import { ban, drop, listBans, unban } from "./moderation.ts";
import { startAuthorization } from "./oauth.ts";
import { PAGE_CSS } from "./status.ts";

import type { ListedClient } from "./presence.ts";

const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_SECONDS = 600;

const STATE_LABEL: Record<ListedClient["state"], string> = { pending: "identifying", replaying: "replaying", live: "live" };
const STATE_CLASS: Record<ListedClient["state"], string> = { pending: "dim", replaying: "run", live: "ok" };

const esc = (value: number | string | null | undefined): string => String(value ?? "").replaceAll(/[&<>"']/g, char => `&#${char.codePointAt(0)};`);
const optional = (value: string | null | undefined): string | null => value?.trim() ? value.trim() : null;
const redirect = (headers: Record<string, string> = {}): Response => new Response(null, { status: 303, headers: { Location: "/admin", ...headers } });

async function current(req: Request, ip: string): Promise<Admin | null> {
    const value = sessionToken(req);
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
.subs input, .subs .more { display: none; }
.subs input:checked ~ .more { display: block; }
.subs label { display: block; color: var(--link); cursor: pointer; }
.subs label::after { content: "▸ " attr(data-more); }
details.filter { display: inline-block; }
details.filter summary { list-style: none; cursor: pointer; }
details.filter summary::-webkit-details-marker { display: none; }
details.filter summary::after { content: "›"; display: inline-block; margin-left: 6px; color: var(--link); transition: transform 0.1s; }
details.filter[open] summary::after { transform: rotate(90deg); }
details.filter > code { display: block; padding-left: 16px; overflow-wrap: anywhere; }
.subs input:checked ~ label::after { content: "▾ show less"; }
.sources { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 2px 12px; margin: 8px 0; }
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
</form>${oauthEnabled ? `
<p>or</p>
<form class="stack" method="post" action="/admin/oauth">
<button type="submit">Log in with e621</button>
</form>` : ""}`, status);
}

function ago(iso: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m ago`;
    return `${Math.floor(seconds / 86_400)}d ${Math.round(seconds % 86_400 / 3600)}h ago`;
}

const button = (action: string, fields: Record<string, string | number>, label: string, confirm?: string): string => `<form class="inline" method="post" action="/admin/${action}"${confirm ? ` data-confirm="${esc(confirm)}" onsubmit="return confirm(this.dataset.confirm)"` : ""}>${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join("")}<button type="submit" class="bad">${label}</button></form>`;

function subscriptions(id: string, list: ListedClient["subscriptions"]): string {
    if (list.length === 0) return "<span class=\"dim\">none</span>";
    const items = list.map(sub => sub.filter ? `<details class="filter"><summary><code>${esc(sub.type)}</code></summary><code>${esc(JSON.stringify(sub.filter))}</code></details>` : `<code>${esc(sub.type)}</code>`);
    if (items.length <= 3) return items.join("<br>");
    return `<div class="subs"><input type="checkbox" id="subs-${esc(id)}">${items.slice(0, 3).join("<br>")}<div class="more">${items.slice(3).join("<br>")}</div><label for="subs-${esc(id)}" data-more="${items.length - 3} more"></label></div>`;
}

// an iso time, or how long ago (90m, 6h, 2d)
function parseTime(value: string | null, fallback: Date): Date {
    const text = value?.trim() ?? "";
    if (text === "") return fallback;
    const relative = /^(\d+)([mhd])$/.exec(text);
    if (relative) return new Date(Date.now() - Number(relative[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"]);
    return new Date(text);
}

function recoverySection(recovery: Recovery | null): string {
    const current = recovery ? `<p>${esc(recovery.id)}: <span class="${recovery.status === "done" ? "ok" : recovery.status === "failed" ? "bad" : isActive(recovery) ? "run" : "dim"}">${recovery.status}</span>, ${esc(recovery.from)} to ${esc(recovery.to)}, ${recovery.events} event(s). Requested by ${esc(recovery.requested_by)} <span title="${esc(recovery.requested_at)}">${ago(recovery.requested_at)}</span>.${recovery.error ? ` <span class="bad">${esc(recovery.error)}</span>` : ""}</p>
${isActive(recovery) ? button("recovery/cancel", {}, "Cancel", "Cancel the recovery? What's been sent so far stays sent.") : ""}
<details><summary>${recovery.sources.length} source(s)</summary><div class="table-wrap"><table>
<tr><th>source</th><th>status</th><th>events</th><th></th></tr>
${recovery.sources.map((name) => {
    const p = recovery.progress[name];
    return `<tr><td><code>${esc(name)}</code></td><td>${esc(p?.status)}</td><td>${p?.events ?? 0}</td><td>${p?.error ? `<span class="bad">${esc(p.error)}</span>` : ""}</td></tr>`;
}).join("")}
</table></div></details>` : "<p>No recoveries yet.</p>";
    if (isActive(recovery)) return current;
    return `${current}
<form method="post" action="/admin/recovery" data-confirm="Start a recovery? Every client is told about it, and what's found is sent to them." onsubmit="return confirm(this.dataset.confirm)">
<div class="stack" style="display: grid; gap: 10px; max-width: 320px;">
<input name="from" placeholder="from: iso time, or 6h / 90m / 2d ago" required>
<input name="to" placeholder="to (default now)">
</div>
<details><summary>sources (all by default)</summary><div class="sources">
${RECOVERABLE.map(name => `<label><input type="checkbox" name="source" value="${esc(name)}" checked> <code>${esc(name)}</code></label>`).join("")}
</div></details>
<button type="submit" class="bad">Recover</button>
</form>`;
}

async function adminPage(admin: Admin, notice?: string): Promise<Response> {
    const [lists, bans, recovery] = await Promise.all([redis.send("HVALS", [clientListKey]) as Promise<Array<string>>, listBans(), getRecovery()]);
    const clients = lists.flatMap(list => JSON.parse(list) as Array<ListedClient>).sort((a, b) => a.connected_at.localeCompare(b.connected_at));
    const clientRows = clients.map(c => `<tr><td>${c.client ? esc(c.client) : "<span class=\"dim\">unnamed</span>"}</td>
<td>${c.user ? `<a href="https://e621.net/users/${c.user_id}">${esc(c.user)}</a>` : "<span class=\"dim\">anonymous</span>"}</td>
<td class="${STATE_CLASS[c.state]}">${STATE_LABEL[c.state]}</td><td>${subscriptions(c.session_id, c.subscriptions)}</td>
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
</table></div>` : "<p>Nobody's banned.</p>"}

<h2>Recovery</h2>
<p class="dim">Re-fetches a window of time the ingester missed, and sends what wasn't sent the first time as <code>recovered</code> events. Pick only the sources that actually missed things, the id based ones can only tell what was sent from the last ${retentionHours}h of the stream.</p>
${recoverySection(recovery)}`);
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
    const setCookie = await createSession(req, admin);
    Debug("gateway:admin", `${admin.name} #${admin.id} logged in from ${ip}`);
    return redirect({ "Set-Cookie": setCookie });
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
        case "recovery": {
            const picked = body.getAll("source").filter(name => RECOVERABLE.includes(name));
            const result = await requestRecovery(parseTime(body.get("from"), new Date(Number.NaN)), parseTime(body.get("to"), new Date()), picked, admin.name);
            if (typeof result === "string") return adminPage(admin, result);
            Debug("gateway:admin", `${admin.name} started recovery ${result.id} (${result.from} to ${result.to}, ${picked.length} source(s))`);
            return redirect();
        }
        case "recovery/cancel": {
            if (await cancelRecovery()) Debug("gateway:admin", `${admin.name} cancelled the recovery`);
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
    if (pathname === "/admin/oauth" && req.method === "POST" && oauthEnabled) {
        const res = await startAuthorization(req, ip, "admin");
        return res ?? loginPage("too many attempts, try again later", 429);
    }
    if (pathname === "/admin/logout" && req.method === "POST") {
        const value = sessionToken(req);
        if (value) await redis.del(sessionKey(value));
        return redirect({ "Set-Cookie": sessionCookie(req, "", 0) });
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
