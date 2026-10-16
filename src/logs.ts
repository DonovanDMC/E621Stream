import { accessSync, constants, createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";

import { e621BaseURL, logDir, logRetentionDays } from "./config.ts";
import { count } from "./metrics.ts";

class DailyLog {
    private date = "";
    private stream: WriteStream | null = null;
    constructor(private readonly name: string) {}

    private prune(): void {
        const cutoff = new Date(Date.now() - logRetentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const pattern = new RegExp(`^${this.name}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
        for (const file of readdirSync(logDir)) {
            const date = pattern.exec(file)?.[1];
            if (date && date < cutoff) rmSync(join(logDir, file), { force: true });
        }
    }

    write(line: string): void {
        const date = new Date().toISOString().slice(0, 10);
        if (date !== this.date) {
            this.stream?.end();
            this.date = date;
            this.stream = createWriteStream(join(logDir, `${this.name}-${date}.log`), { flags: "a" });
            this.stream.on("error", () => null);
            this.prune();
        }
        this.stream!.write(line);
    }
}

function tee(stream: NodeJS.WriteStream, log: DailyLog): void {
    const write = stream.write.bind(stream);
    let partial = "";
    stream.write = (chunk: string | Uint8Array, ...rest: Array<never>): boolean => {
        const lines = (partial + (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())).split("\n");
        partial = lines.pop()!;
        for (const line of lines) log.write(`${new Date().toISOString()} ${Bun.stripANSI(line)}\n`);
        return write(chunk, ...rest);
    };
}

function username(headers: Headers): string {
    const auth = headers.get("Authorization");
    if (!auth?.startsWith("Basic ")) return "-";
    // never log the key
    return atob(auth.slice(6)).split(":")[0] ?? "-";
}

/**
 * counts every request made to e621 for the status page, and logs them if there's a log, retries included since the
 * module calls fetch once per attempt
 */
function watchRequests(role: string, log: DailyLog | null): void {
    const host = new URL(e621BaseURL).host;
    const original = globalThis.fetch;
    const logged = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : null;
        const url = request?.url ?? (input instanceof URL ? input.href : input as string);
        if (new URL(url).host !== host) return original(input, init);
        const method = request?.method ?? init?.method ?? "GET";
        const user = username(request?.headers ?? new Headers(init?.headers));
        const start = performance.now();
        const line = (result: string): void => {
            const ms = Math.round(performance.now() - start);
            count(`request_ms.${role}`, ms);
            log?.write(`${new Date().toISOString()} ${method} ${result} ${ms}ms ${url} ${user}\n`);
        };
        count(`requests.${role}`);
        try {
            const res = await original(input, init);
            line(String(res.status));
            if (res.status === 429) count(`ratelimited.${role}`);
            if (res.status >= 400) count(`failed.${role}`);
            return res;
        } catch (err) {
            line(`failed (${String(err)})`);
            count(`failed.${role}`);
            throw err;
        }
    };
    globalThis.fetch = Object.assign(logged, { preconnect: original.preconnect.bind(original) });
}

function openLogs(): boolean {
    if (!logDir) return false;
    try {
        mkdirSync(logDir, { recursive: true });
        // docker creates missing bind mounts as root
        accessSync(logDir, constants.W_OK);
        return true;
    } catch (err) {
        console.error(`can't write to ${logDir}, logging to files is disabled: ${String(err)}`);
        return false;
    }
}

export function startLogging(role: string): void {
    const files = openLogs();
    if (files) {
        const app = new DailyLog(role);
        tee(process.stdout, app);
        tee(process.stderr, app);
    }
    watchRequests(role, files ? new DailyLog(`requests-${role}`) : null);
}
