import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import Config from "../Config.ts";

import { recordRequest } from "./latency.ts";
import { count } from "./metrics.ts";
import { pickRoute, reportRoute, ROUTE_DOWN_MS, ROUTES } from "./Route.ts";

export default class FileLog {
    dir: string;
    name: string;
    stream: WriteStream | null = null;
    constructor(name: string) {
        this.name = name;
        if (isAbsolute(Config.logDir)) {
            this.dir = Config.logDir;
        } else {
            this.dir = resolve(process.cwd(), Config.logDir);
        }
    }

    private open(): void {
        if (this.stream && !this.stream.writableEnded) this.stream.end();
        this.stream = createWriteStream(join(this.dir, `${this.name}.log`), { flags: "a" });
        this.stream.on("error", () => {});
    }

    write(line: string): boolean {
        if (!this.stream?.writable) this.open();
        return this.stream!.write(line);
    }
}

// NodeJS.WriteStream and WriteStream from node:fs are apparently different
function tee(stream: NodeJS.WriteStream, log: FileLog): void {
    const write = stream.write.bind(stream);
    let partial = "";
    stream.write = (chunk: string | Uint8Array, ...rest: Array<never>): boolean => {
        const lines = (partial + (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())).split("\n");
        partial = lines.pop()!;
        for (const line of lines) log.write(`[${new Date().toISOString()}] ${Bun.stripANSI(line)}\n`);
        return write(chunk, ...rest);
    };
}

function username(headers: Headers): string {
    const auth = headers.get("Authorization");
    if (!auth?.startsWith("Basic ")) return "-";
    // never log the key
    return atob(auth.slice(6)).split(":")[0] ?? "-";
}

async function filesAvailable(): Promise<boolean> {
    if (!Config.logDir) return false;
    try {
        await mkdir(Config.logDir, { recursive: true });
        await access(Config.logDir, constants.W_OK);
        return true;
    } catch (err) {
        console.error(`can't write to ${Config.logDir}, logging to files is not available: ${String(err)}`);
        return false;
    }
}

let events: FileLog | null;

// frame is a function to avoid needing to build the strings/stringify/etc unless it will actually be logged
export function logEvent(frame: () => string, sent: number): void {
    events?.write(`[${new Date().toISOString()}] ${sent} ${frame()}\n`);
}

function watchRequests(name: string, log: FileLog | null): void {
    const host = new URL(Config.e621BaseURL).host;
    const original = globalThis.fetch;
    let turn = 0;
    const logged = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : null;
        const url = request?.url ?? (input instanceof URL ? input.href : input as string);
        if (new URL(url).host !== host) return original(input, init);
        const method = request?.method ?? init?.method ?? "GET";
        const user = username(request?.headers ?? new Headers(init?.headers));
        const route = pickRoute(ROUTES, turn++);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!route) throw new Error(`Failed to select route for ${method} ${url}`);
        route.inFlight++;
        const start = performance.now();
        const line = (result: string, failed: boolean): void => {
            const ms = Math.round(performance.now() - start);
            count(`request_ms.${name}`, ms);
            count(`requestroute_ms.${route.name}`, ms);
            recordRequest(ms, failed);
            reportRoute(name, route, failed);
            log?.write(`[${new Date().toISOString()}] ${method} ${result} ${ms}ms ${url} ${user} via ${route.name}\n`);
        };
        count(`requests.${name}`);
        count(`route.${route.name}`);
        try {
            const res = await original(input, route.proxy ? { ...init, proxy: route.proxy } : init);
            line(String(res.status), res.status >= 500);
            if (res.status === 429) count(`ratelimited.${name}`);
            if (res.status >= 400) {
                count(`failed.${name}`);
                count(`routefailed.${route.name}`);
            }
            return res;
        } catch (err) {
            if (route.proxy) route.downUntil = Date.now() + ROUTE_DOWN_MS;
            line(`failed (${String(err)})`, true);
            count(`failed.${name}`);
            count(`routefailed.${route.name}`);
            throw err;
        } finally {
            route.inFlight--;
        }
    };

    globalThis.fetch = Object.assign(logged, { preconnect: original.preconnect.bind(original) });
}

export async function startLogging(name: string): Promise<void> {
    const files = await filesAvailable();
    if (files) {
        if (Config.logEvents) events = new FileLog(`events-${name}`);
        const app = new FileLog(name);
        tee(process.stdout, app);
        tee(process.stderr, app);
    }
    watchRequests(name, files ? new FileLog(`requests-${name}`) : null);
}
