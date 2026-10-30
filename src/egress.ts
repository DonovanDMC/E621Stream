// e621 seems to handle requests from each ip one at a time, so these let requests go out from the server's
// other addresses. which one is decided by the docker network it's on
import { lookup } from "node:dns/promises";
import { connect, createServer, type Socket } from "node:net";

import Debug from "@yiffy/debug";

import { e621BaseURL, egressFamily, port } from "./config.ts";

const allowed = new URL(e621BaseURL).hostname;
const MAX_HEADER_BYTES = 8192;

function reply(socket: Socket, status: string): void {
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

function handle(socket: Socket): void {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) {
            if (head.length > MAX_HEADER_BYTES) reply(socket, "431 Request Header Fields Too Large");
            return;
        }
        socket.off("data", onData);
        const [method, target] = head.subarray(0, head.indexOf("\r\n")).toString("latin1").split(" ");
        if (method === "GET" && target === "/health") {
            reply(socket, "200 OK");
            return;
        }
        const [host, targetPort] = (target ?? "").split(":");
        if (method !== "CONNECT" || host !== allowed || targetPort !== "443") {
            reply(socket, "403 Forbidden");
            return;
        }
        const rest = head.subarray(end + 4);
        void tunnel(socket, host, rest);
    };
    socket.on("data", onData);
    socket.on("error", () => null);
}

async function tunnel(socket: Socket, host: string, rest: Buffer): Promise<void> {
    let address: string;
    try {
        ({ address } = await lookup(host, { family: egressFamily }));
    } catch (err) {
        Debug("egress", `couldn't resolve ${host}: ${String(err)}`);
        reply(socket, "502 Bad Gateway");
        return;
    }
    const upstream = connect({ host: address, port: 443 }, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length !== 0) upstream.write(rest);
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    upstream.on("error", (err) => {
        Debug("egress", `connecting to ${host} failed: ${String(err)}`);
        if (socket.writable) reply(socket, "502 Bad Gateway");
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
}

export function startEgress(): void {
    createServer(handle).listen(port, () => { Debug("egress", `tunneling to ${allowed} over IPv${egressFamily} on port ${port}`); });
}
