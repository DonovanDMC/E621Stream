import Debug from "@yiffy/debug";

import { adminUserIDs, authorizeURL, authRequired, gitCommit, maxConnectionsPerIP, oauthEnabled, port, publicURL, trustProxy } from "../config.ts";
import { EVENT_TYPES } from "../events.ts";
import { pagesDir, renderPages } from "../pages.ts";
import redis from "../redis.ts";

import { handleAdmin } from "./admin.ts";
import { parseAuthHeader } from "./auth.ts";
import { COMPRESSION_TYPES, isCompressionType, type CompressionType } from "./compression.ts";
import { hubStats, startHub } from "./hub.ts";
import { startModeration } from "./moderation.ts";
import { handleAuthorize, migrateOAuth } from "./oauth.ts";
import { connectionsChanged, startPresence } from "./presence.ts";
import { startPrivate } from "./private.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { connectionCount, Session, sessions, type SocketData } from "./session.ts";
import { status, statusPage } from "./status.ts";

function clientIP(req: Request, server: Bun.Server<SocketData>): string {
    if (trustProxy) {
        const forwarded = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
        if (forwarded) return forwarded;
    }
    return server.requestIP(req)?.address ?? "unknown";
}

let pages: Promise<Map<string, string>> | null = null;

async function servePage(pathname: string): Promise<Response | null> {
    pages ??= renderPages();
    const rendered = await pages;
    const html = rendered.get(pathname);
    if (html) return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    if (rendered.has(`${pathname}/`)) return new Response(null, { status: 308, headers: { Location: `${pathname}/` } });
    return null;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } });

export function startGateway(): void {
    const server = Bun.serve({
        port,
        fetch(req, srv) {
            const url = new URL(req.url);
            if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
                return handleAdmin(req, clientIP(req, srv)).catch((err: unknown) => new Response(`admin unavailable: ${String(err)}`, { status: 503 }));
            }
            if (oauthEnabled && (url.pathname === "/authorize" || url.pathname.startsWith("/authorize/"))) {
                return handleAuthorize(req, clientIP(req, srv)).catch((err: unknown) => {
                    Debug("gateway:oauth", `${url.pathname} failed: ${String(err)}`);
                    return new Response("authorizing is unavailable right now", { status: 503 });
                });
            }
            switch (url.pathname) {
                case "/ws": {
                    const ip = clientIP(req, srv);
                    if (maxConnectionsPerIP > 0 && connectionCount(ip) >= maxConnectionsPerIP) {
                        return json({ error: "too many connections from this address" }, 429);
                    }
                    const compress = url.searchParams.get("compress") ?? "";
                    let compression: CompressionType | null = null;
                    if (compress !== "") {
                        if (!isCompressionType(compress)) return json({ error: `compress must be one of ${COMPRESSION_TYPES.join(", ")}` }, 400);
                        compression = compress;
                    }
                    const headerAuth = parseAuthHeader(req.headers.get("authorization"));
                    if (srv.upgrade(req, { data: { ip, compression, headerAuth } })) return;
                    return json({ error: "expected a websocket upgrade" }, 426);
                }

                case "/info":
                    return json({
                        name: "E621Stream",
                        version: PROTOCOL_VERSION,
                        commit: gitCommit,
                        websocket: publicURL,
                        auth_required: authRequired,
                        authorize: oauthEnabled ? authorizeURL : null,
                        compression: COMPRESSION_TYPES,
                        events: EVENT_TYPES,
                    });

                case "/health":
                    return redis.ping()
                        .then(() => json({ ok: true, last_event_id: hubStats.lastId, last_event_at: hubStats.lastEventAt }))
                        .catch(() => json({ ok: false }, 503));

                case "/status":
                    return statusPage()
                        .then(html => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
                        .catch((err: unknown) => new Response(`status unavailable: ${String(err)}`, { status: 503 }));

                case "/status.json":
                    return status().then(data => json(data)).catch((err: unknown) => json({ error: String(err) }, 503));

                case "/favicon.ico":
                    return new Response(Bun.file(`${pagesDir}/favicon.ico`), { headers: { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" } });

                case "/stats":
                    return json({ connections: sessions.size, events_received: hubStats.received, last_event_id: hubStats.lastId, last_event_at: hubStats.lastEventAt });

                default:
                    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "not found" }, 404);
                    return servePage(url.pathname)
                        .then(res => res ?? json({ error: "not found" }, 404))
                        .catch((err: unknown) => {
                            Debug("gateway", `couldn't render the docs: ${String(err)}`);
                            return new Response("the docs are unavailable right now", { status: 503 });
                        });
            }
        },
        websocket: {
            data: {} as SocketData,
            perMessageDeflate: true,
            maxPayloadLength: 64 * 1024,
            idleTimeout: 120,
            sendPings: true,
            open(ws) {
                ws.data.session = new Session(ws);
                connectionsChanged();
            },
            message(ws, message) {
                ws.data.session?.handleMessage(message).catch((err: unknown) => {
                    Debug("gateway:session", `message handling failed: ${String(err)}`);
                    ws.data.session?.close(4000, "internal error");
                });
            },
            close(ws) {
                ws.data.session?.cleanup();
            },
        },
    });

    if (oauthEnabled) void migrateOAuth().catch((err: unknown) => { Debug("gateway:oauth", `couldn't create the tables: ${String(err)}`); });
    // rendered up front so a broken page shows up in the logs on start
    pages = renderPages();
    pages.catch((err: unknown) => { Debug("gateway", `couldn't render the docs: ${String(err)}`); });
    void startHub();
    void startPrivate().catch((err: unknown) => { Debug("gateway:private", `couldn't start: ${String(err)}`); });
    void startModeration().catch((err: unknown) => { Debug("gateway:admin", `couldn't start: ${String(err)}`); });
    startPresence();
    setInterval(() => {
        for (const session of sessions) void session.recheckAuth().catch(() => null);
    }, 60_000);
    Debug("gateway", `listening on ${server.url.href}`);
    Debug("gateway:oauth", oauthEnabled ? `authorizing at ${authorizeURL}` : "no E621_OAUTH_CLIENT_ID/E621_OAUTH_CLIENT_SECRET set, /authorize is off");
    Debug("gateway:admin", adminUserIDs.size === 0 ? "no ADMIN_USER_IDS set, nobody can log in to /admin" : `admins: ${[...adminUserIDs].map(id => `#${id}`).join(", ")}`);
}
