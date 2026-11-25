// Holds a fluctuating number of connections open against an egress server with a mix of tunnels,
// real requests, forbidden targets & plain http, then prints what happened to each kind.
// usage: bun scripts/egressLoad.ts [--url http://host:port] [--duration 180] [--min 10] [--max 50] [--rps 1]
import { connect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { parseArgs } from "node:util";

const { values } = parseArgs({
    options: {
        url: { type: "string", default: "http://egress-1.e621stream.containers.local:4002" },
        duration: { type: "string", default: "180" },
        min: { type: "string", default: "10" },
        max: { type: "string", default: "50" },
        // cap on real requests sent to e621, across all connections
        rps: { type: "string", default: "1" },
    },
});

const proxy = new URL(values.url);
const proxyHost = proxy.hostname, proxyPort = Number(proxy.port || 80);
const duration = Number(values.duration) * 1000, min = Number(values.min), max = Number(values.max), rps = Number(values.rps);
const e621Host = new URL(process.env.E621_BASE_URL ?? "https://e621.net").hostname;
const userAgent = process.env.E621_USER_AGENT ?? "E621Stream/egress-load (by Donovan_DMC)";

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const rand = (low: number, high: number): number => low + Math.random() * (high - low);
const randInt = (low: number, high: number): number => Math.floor(rand(low, high + 1));
const pick = <T>(list: Array<T>): T => list[Math.floor(Math.random() * list.length)]!;

const sockets = [] as Array<Socket>;
const stop = new AbortController();

function open(): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: proxyHost, port: proxyPort });
        sockets.push(socket);
        socket.once("close", () => sockets.splice(sockets.indexOf(socket), 1));
        socket.once("connect", () => {
            socket.off("error", reject);
            resolve(socket);
        });
        socket.once("error", reject);
    });
}

// reads a response head & returns its status, leaving the socket paused
function readStatus(socket: Socket, timeout = 10_000): Promise<number> {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const finish = (err: Error | null, status = 0): void => {
            clearTimeout(timer);
            socket.off("data", onData).off("error", onError).off("close", onClose);
            socket.pause();
            if (err) reject(err); else resolve(status);
        };
        const onData = (chunk: Buffer): void => {
            buf = Buffer.concat([buf, chunk]);
            const end = buf.indexOf("\r\n\r\n");
            if (end !== -1) finish(null, Number(buf.subarray(0, buf.indexOf("\r\n")).toString().split(" ")[1]));
        };
        const onError = (err: Error): void => { finish(err); };
        const onClose = (): void => { finish(new Error("closed")); };
        const timer = setTimeout(() => { finish(new Error("timeout")); }, timeout);
        socket.on("data", onData).once("error", onError).once("close", onClose);
        socket.resume();
    });
}

// resolves null if the socket stayed open for the whole time, otherwise how long it lasted
function hold(socket: Socket, ms: number): Promise<number | null> {
    return new Promise((resolve) => {
        if (socket.destroyed) {
            resolve(0);
            return;
        }
        const start = Date.now();
        const onClose = (): void => {
            clearTimeout(timer);
            resolve(Date.now() - start);
        };
        const timer = setTimeout(() => {
            socket.off("close", onClose);
            resolve(null);
        }, ms);
        socket.once("close", onClose);
        // keep reading so a remote close is noticed
        socket.on("data", () => null).resume();
    });
}

// lifetimes are bucketed so the outcomes stay readable, e621 drops idle connections at ~15s
const closedAfter = (lasted: number | null, who = "closed"): string => lasted === null ? "ok" : `${who} after ~${Math.round(lasted / 5000) * 5}s`;

const latencies = new Map<string, Array<number>>();
async function tunnel(scenario: string, target: string): Promise<{ socket: Socket; status: number }> {
    const socket = await open();
    const start = performance.now();
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    const status = await readStatus(socket);
    const list = latencies.get(scenario) ?? [];
    list.push(performance.now() - start);
    latencies.set(scenario, list);
    return { socket, status };
}

function tls(socket: Socket): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const secure = tlsConnect({ socket, servername: e621Host });
        sockets.push(secure);
        secure.once("close", () => sockets.splice(sockets.indexOf(secure), 1));
        const timer = setTimeout(() => {
            secure.destroy();
            reject(new Error("tls timeout"));
        }, 10_000);
        secure.once("secureConnect", () => {
            clearTimeout(timer);
            secure.off("error", reject);
            resolve(secure);
        });
        secure.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

let nextRequest = 0;
async function rateLimit(): Promise<void> {
    const now = Date.now(), at = Math.max(now, nextRequest);
    nextRequest = at + 1000 / rps;
    await sleep(at - now);
}

interface Scenario {
    name: string;
    weight: number;
    run(): Promise<string>;
}
const scenarios: Array<Scenario> = [
    {
        // tunnel opened & left idle
        name: "idle", weight: 25, async run(): Promise<string> {
            const { socket, status } = await tunnel(this.name, `${e621Host}:443`);
            if (status !== 200) return `status ${status}`;
            return closedAfter(await hold(socket, rand(2_000, 60_000)));
        },
    },
    {
        // tunnel with a tls handshake, no requests
        name: "tls", weight: 15, async run(): Promise<string> {
            const { socket, status } = await tunnel(this.name, `${e621Host}:443`);
            if (status !== 200) return `status ${status}`;
            const secure = await tls(socket);
            return closedAfter(await hold(secure, rand(2_000, 40_000)));
        },
    },
    {
        // a real request after sitting on the tunnel for a bit
        name: "request", weight: 20, async run(): Promise<string> {
            const { socket, status } = await tunnel(this.name, `${e621Host}:443`);
            if (status !== 200) return `status ${status}`;
            const secure = await tls(socket);
            const lasted = await hold(secure, rand(0, 20_000));
            if (lasted !== null) return closedAfter(lasted, "closed before request");
            await rateLimit();
            secure.write(`GET /posts.json?limit=1 HTTP/1.1\r\nHost: ${e621Host}\r\nUser-Agent: ${userAgent}\r\nConnection: close\r\n\r\n`);
            const res = await readStatus(secure, 15_000);
            return res === 200 ? "ok" : `upstream ${res}`;
        },
    },
    {
        name: "forbidden", weight: 15, async run(): Promise<string> {
            const target = pick(["example.com:443", `${e621Host}:80`, `static1.${e621Host}:443`, "127.0.0.1:443", e621Host, `${e621Host}:443:443`, ""]);
            const { socket, status } = await tunnel(this.name, target);
            socket.destroy();
            return status === 403 ? "ok" : `status ${status} for "${target}"`;
        },
    },
    {
        name: "http", weight: 10, async run(): Promise<string> {
            const [method, path] = pick([["GET", "/health"], ["GET", "/health"], ["GET", "/"], ["GET", "/nope"], ["GET", "/health?x=1"], ["POST", "/health"]]);
            const expected = method === "GET" && path === "/health" ? 200 : 403;
            const socket = await open();
            socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${proxy.host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
            const status = await readStatus(socket);
            socket.destroy();
            return status === expected ? "ok" : `status ${status} for ${method} ${path}`;
        },
    },
    {
        // a CONNECT whose headers never finish
        name: "stall", weight: 10, async run(): Promise<string> {
            const socket = await open();
            socket.write(`CONNECT ${e621Host}:443 HTTP/1.1\r\n`);
            return closedAfter(await hold(socket, rand(2_000, 30_000)), "closed by server");
        },
    },
];
const totalWeight = scenarios.reduce((sum, s) => sum + s.weight, 0);
function pickScenario(): Scenario {
    let roll = Math.random() * totalWeight;
    for (const scenario of scenarios) if ((roll -= scenario.weight) < 0) return scenario;
    return scenarios.at(-1)!;
}

const outcomes = new Map<string, Map<string, number>>(scenarios.map(s => [s.name, new Map()]));
let workers = 0;
async function worker(): Promise<void> {
    workers++;
    const scenario = pickScenario();
    let outcome: string;
    try {
        outcome = await scenario.run();
    } catch (err) {
        outcome = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    }
    if (!stop.signal.aborted) {
        const counts = outcomes.get(scenario.name)!;
        counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
        // so quick scenarios don't churn through hundreds of connections a second
        await sleep(rand(500, 3_000));
    }
    workers--;
}

async function health(): Promise<string> {
    try {
        const res = await fetch(new URL("/health", proxy), { signal: AbortSignal.timeout(2_000) });
        return await res.text();
    } catch (err) {
        return `health failed: ${(err as Error).message}`;
    }
}

const started = Date.now();
let target = randInt(min, max);
let retargetAt = 0;
let reportAt = 0;
process.once("SIGINT", () => { stop.abort(); });
console.log(`hitting ${values.url} for ${duration / 1000}s with ${min}-${max} connections`);

while (!stop.signal.aborted && Date.now() - started < duration) {
    const now = Date.now();
    if (now >= retargetAt) {
        target = Math.min(max, Math.max(min, target + randInt(-15, 15)));
        retargetAt = now + rand(5_000, 15_000);
    }
    while (workers < target) void worker();
    if (now >= reportAt) {
        reportAt = now + 5_000;
        void health().then((h) => { console.log(`[${Math.round((Date.now() - started) / 1000)}s] target=${target} workers=${workers} sockets=${sockets.length} ${h}`); });
    }
    await sleep(100);
}

stop.abort();
for (const socket of [...sockets]) socket.destroy();
while (workers > 0) await sleep(50);

const percentile = (list: Array<number>, p: number): number => list.toSorted((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))] ?? 0;
console.log("\nscenario   runs  connect p50/p95  outcomes");
for (const { name } of scenarios) {
    const counts = outcomes.get(name)!, times = latencies.get(name) ?? [];
    const runs = [...counts.values()].reduce((a, b) => a + b, 0);
    const timing = times.length === 0 ? "-" : `${percentile(times, 0.5).toFixed(0)}/${percentile(times, 0.95).toFixed(0)}ms`;
    console.log(`${name.padEnd(10)} ${String(runs).padStart(4)}  ${timing.padEnd(15)}  ${[...counts].map(([k, v]) => `${k}: ${v}`).join(", ")}`);
}
console.log(`\nafter: ${await health()}`);
