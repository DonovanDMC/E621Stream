import Debug from "@yiffy/debug";

import { authRequired, maxConnectionsPerIP, port, publicURL, trustProxy } from "../config.ts";
import { EVENT_TYPES } from "../events.ts";
import redis from "../redis.ts";

import { parseBasicAuth } from "./auth.ts";
import { hubStats, startHub } from "./hub.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { connectionCount, Session, sessions, type SocketData } from "./session.ts";

function clientIP(req: Request, server: Bun.Server<SocketData>): string {
    if (trustProxy) {
        const forwarded = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
        if (forwarded) return forwarded;
    }
    return server.requestIP(req)?.address ?? "unknown";
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } });

export function startGateway(): void {
    const server = Bun.serve({
        port,
        fetch(req, srv) {
            const url = new URL(req.url);
            switch (url.pathname) {
                case "/ws": {
                    const ip = clientIP(req, srv);
                    if (maxConnectionsPerIP > 0 && connectionCount(ip) >= maxConnectionsPerIP) {
                        return json({ error: "too many connections from this address" }, 429);
                    }
                    const headerAuth = parseBasicAuth(req.headers.get("authorization"));
                    if (srv.upgrade(req, { data: { ip, headerAuth } })) return;
                    return json({ error: "expected a websocket upgrade" }, 426);
                }

                // the docs are at / in production
                case "/":
                case "/info":
                    return json({
                        name: "E621Stream",
                        version: PROTOCOL_VERSION,
                        websocket: publicURL,
                        auth_required: authRequired,
                        events: EVENT_TYPES,
                    });

                case "/health":
                    return redis.ping()
                        .then(() => json({ ok: true, last_event_id: hubStats.lastId, last_event_at: hubStats.lastEventAt }))
                        .catch(() => json({ ok: false }, 503));

                case "/stats":
                    return json({ connections: sessions.size, events_received: hubStats.received, last_event_id: hubStats.lastId, last_event_at: hubStats.lastEventAt });

                default:
                    return json({ error: "not found" }, 404);
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

    void startHub();
    setInterval(() => {
        for (const session of sessions) void session.recheckAuth().catch(() => null);
    }, 60_000);
    Debug("gateway", `listening on ${server.url.href}`);
}
