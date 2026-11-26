import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { connect } from "node:net";

import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import EgressConfig from "../config/EgressConfig.ts";
import { startLogging } from "../util/FileLog.ts";

import type { Duplex } from "node:stream";

await startLogging("egress");

const allowedHosts = [new URL(Config.e621BaseURL).hostname];
let connections = 0, tunnels = 0;

function reply(socket: Duplex, status: string): void {
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

async function tunnel(target: string, socket: Duplex, head: Buffer): Promise<void> {
    const [host, targetPort] = target.split(":") as [string, string | undefined];
    if (!allowedHosts.includes(host) || targetPort !== "443") {
        reply(socket, "403 Forbidden");
        return;
    }

    let address: string;
    try {
        const result = await lookup(host, { family: EgressConfig.family });
        address = result.address;
    } catch (err) {
        Debug("egress", `couldn't resolve ${target}: ${String(err)}`);
        reply(socket, "502 Bad Gateway");
        return;
    }
    if (socket.destroyed) return;

    const upstream = connect({ host: address, port: 443 }, () => {
        tunnels++;
        socket.once("close", () => tunnels--);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
    })
        .on("error", (err) => {
            Debug("egress", `connecting to ${target} (${address}) failed: ${String(err)}`);
            if (socket.writable) reply(socket, "502 Bad Gateway");
        })
        .on("close", () => socket.destroy());

    socket.on("close", () => upstream.destroy());
}

createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ uptime: process.uptime(), tunnels, connections }));
    } else res.writeHead(403).end();
})
    .on("connect", (req, socket, head) => {
        connections++;
        socket.once("close", () => connections--);
        socket.on("error", () => null); // ignore errors
        void tunnel(req.url ?? "", socket, head);
    })
    .listen(EgressConfig.port, () => { Debug("egress", `Tunneling over IPv${EgressConfig.family} to ${allowedHosts.join(", ")} on :${EgressConfig.port}`); });
