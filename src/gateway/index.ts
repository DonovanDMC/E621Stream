import Debug from "@yiffy/debug";

import Config from "../Config.ts";
import { startLogging } from "../util/FileLog.ts";
import I18n from "../util/I18n.ts";
import { checkServices, clientIP } from "../util/util.ts";

import { parseAuthHeader } from "./auth.ts";
import { COMPRESSION_TYPES, type CompressionType } from "./compression.ts";
import { startHub } from "./hub.ts";
import { startManagement } from "./management.ts";
import { connectionsChanged, startPresence } from "./presence.ts";
import { startPrivate } from "./private.ts";
import { CloseCodes } from "./protocol.ts";
import Session, { connectionsByIP, sessions, type SocketData } from "./Session.ts";

await startLogging("gateway");
await checkServices();

const server = Bun.serve({
    hostname: Config.host,
    port: Config.gatewayPort,
    websocket: {
        data: {} as SocketData,
        perMessageDeflate: true,
        maxPayloadLength: 64 * 1024,
        idleTimeout: Config.wsIdleTimeout,
        sendPings: true,
        backpressureLimit: Config.maxBufferedBytes * 2,
        async open(ws) {
            ws.data.session = new Session(ws);
            connectionsChanged();
            await ws.data.session.hello();
        },
        async message(ws, message) {
            if (ws.data.session) {
                try {
                    await ws.data.session.handleMessage(message);
                } catch (err) {
                    Debug("gateway:session", `message handling failed: ${String(err)}`);
                    await ws.data.session.close(CloseCodes.UnknownError, I18n.t("gateway.internalError"));
                }
            }
        },
        close(ws) {
            ws.data.session?.cleanup();
        },
    },
    fetch(req: Bun.BunRequest, srv: Bun.Server<SocketData>) {
        const url = new URL(req.url);
        if (url.pathname === "/health") return new Response("OK");
        if (url.pathname === "/ws") {
            const ip = clientIP(req, srv);
            if (Config.maxConnectionsPerIP > 0 && (connectionsByIP.get(ip) ?? 0) >= Config.maxConnectionsPerIP) {
                return Response.json({ error: I18n.t("gateway.tooManyConnections", { max: Config.maxConnectionsPerIP }) }, 429);
            }
            const compression = url.searchParams.get("compress") as CompressionType;
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (compression) {
                if (!COMPRESSION_TYPES.includes(compression)) return Response.json({ error: I18n.t("gateway.invalidCompression", { types: COMPRESSION_TYPES.join(", ") }) }, 400);
            }
            const headerAuth = parseAuthHeader(req.headers.get("authorization"));
            if (srv.upgrade(req, { data: { ip, compression, headerAuth } })) return;
            return Response.json({ error: I18n.t("gateway.expectedUpgrade") }, 426);
        }
    },
});

startPresence();
void startHub(sessions);
await startPrivate();
await startManagement(sessions);
setInterval(() => {
    for (const session of [...sessions]) void session.recheckAuth().catch(() => null);
}, Config.sessionRecheckInterval);
Debug("gateway", `listening on ${server.url.href}`);
