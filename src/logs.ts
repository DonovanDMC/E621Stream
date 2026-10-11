import { accessSync, constants, createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";

import { e621BaseURL, logDir, logRetentionDays } from "./config.ts";

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

/** logs every request made to e621, retries included, since the module calls fetch once per attempt */
function logRequests(log: DailyLog): void {
    const host = new URL(e621BaseURL).host;
    const original = globalThis.fetch;
    const logged = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : null;
        const url = request?.url ?? (input instanceof URL ? input.href : input as string);
        if (new URL(url).host !== host) return original(input, init);
        const method = request?.method ?? init?.method ?? "GET";
        const user = username(request?.headers ?? new Headers(init?.headers));
        const start = performance.now();
        const line = (result: string): void => { log.write(`${new Date().toISOString()} ${method} ${result} ${Math.round(performance.now() - start)}ms ${url} ${user}\n`); };
        try {
            const res = await original(input, init);
            line(String(res.status));
            return res;
        } catch (err) {
            line(`failed (${String(err)})`);
            throw err;
        }
    };
    globalThis.fetch = Object.assign(logged, { preconnect: original.preconnect.bind(original) });
}

export function startLogging(role: string): void {
    if (!logDir) return;
    try {
        mkdirSync(logDir, { recursive: true });
        // docker creates missing bind mounts as root
        accessSync(logDir, constants.W_OK);
    } catch (err) {
        console.error(`can't write to ${logDir}, logging to files is disabled: ${String(err)}`);
        return;
    }
    const app = new DailyLog(role);
    tee(process.stdout, app);
    tee(process.stderr, app);
    logRequests(new DailyLog(`requests-${role}`));
}
