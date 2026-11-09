// connects to the gateway and logs every packet it receives
// bun run client [--url ws://127.0.0.1:3621/ws] [--cursor <id>] [--pretty] [subscription...]
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        url: { type: "string", default: Bun.env.STREAM_URL ?? "ws://127.0.0.1:3621/ws" },
        cursor: { type: "string" },
        pretty: { type: "boolean", default: false },
    },
});

// bun loads .env, so this uses the ingester's account unless overridden
const username = Bun.env.CLIENT_USER ?? Bun.env.E621_AUTH_USER;
const apiKey = Bun.env.CLIENT_KEY ?? Bun.env.E621_AUTH_KEY;
const subscriptions = positionals.length === 0 ? ["*"] : positionals;

function log(direction: "<" | ">", packet: unknown): void {
    const json = JSON.stringify(packet, (key, value: unknown) => key === "api_key" ? "[redacted]" : value, values.pretty ? 2 : undefined);
    console.log(`${new Date().toISOString()} ${direction} ${json}`);
}

function send(packet: unknown): void {
    log(">", packet);
    ws.send(JSON.stringify(packet));
}

const ws = new WebSocket(values.url);
ws.addEventListener("open", () => { console.log(`connected to ${values.url}`); });
ws.addEventListener("message", ({ data }) => {
    let packet: { op?: string };
    try {
        packet = JSON.parse(String(data)) as { op?: string };
    } catch {
        console.log(`${new Date().toISOString()} < (not json) ${String(data)}`);
        return;
    }
    log("<", packet);
    if (packet.op === "hello") {
        send({
            op: "identify",
            d: {
                auth: username && apiKey ? { username, api_key: apiKey } : undefined,
                client: "e621stream test client",
                cursor: values.cursor,
                subscriptions,
            },
        });
    }
});
ws.addEventListener("close", ({ code, reason }) => {
    console.log(`closed: ${code}${reason ? ` ${reason}` : ""}`);
    process.exit(code === 1000 ? 0 : 1);
});
ws.addEventListener("error", () => { console.log("websocket error"); });

process.on("SIGINT", () => { ws.close(1000); });
