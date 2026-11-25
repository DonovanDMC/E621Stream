import { createHash, randomBytes } from "node:crypto";

import Config from "../Config.ts";
import DB from "../db/DB.ts";
import Redis from "../db/Redis.ts";

export const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function cookieSecure(req: Request): boolean {
    return new URL(req.url).protocol === "https:" || (Config.trustProxy && req.headers.get("x-forwarded-proto") === "https");
}

export function clientIP(req: Bun.BunRequest, server: Bun.Server<unknown>): string {
    if (Config.trustProxy) {
        const cf = req.headers.get("cf-connecting-ip");
        if (cf) return cf;
        const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
        if (forwarded) return forwarded;
    }
    const ip = server.requestIP(req)?.address;
    if (ip) return ip;
    console.warn(`Failed to get ip for request to ${req.url}`);
    return "unknown";
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: Timer | undefined;
    return Promise.race([
        promise,
        // never used to avoid tainting the Promise<T> return
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reject(new Error(`${label} timed out after ${ms}ms`)); }, ms);
        }),
    ]).finally(() => { clearTimeout(timer); });
}

type CheckResult = { ms: number; ok: true } | { error: string; ms: number; ok: false };
export async function check(label: string, fn: () => Promise<unknown>, timeoutMs: number): Promise<CheckResult> {
    const start = performance.now();
    try {
        await withTimeout(fn(), timeoutMs, label);
        return { ok: true, ms: Math.round(performance.now() - start) };
    } catch (err) {
        return {
            ok: false,
            ms: Math.round(performance.now() - start),
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

export async function checkServices(ms = 5000, exit = true): Promise<{ postgres: CheckResult; redis: CheckResult }> {
    const redis = await check("redis", () => Redis.ping(), ms);
    const postgres = await check("postgres", () => DB`SELECT 1`, ms);
    if (exit) {
        let ok = true;
        if (!redis.ok) {
            console.error(`Redis check failed: ${redis.error}`);
            if (postgres.ok) console.log("Postgres check passed");
            ok = false;
        }
        if (!postgres.ok) {
            if (redis.ok) console.log("Redis check passed");
            console.error(`Postgres check failed: ${postgres.error}`);
            ok = false;
        }

        if (!ok) process.exit(1);
    }
    return { postgres, redis };
}

export function genSessionID(): string {
    return randomBytes(32).toString("hex");
}

const LOCAL = "http://localhost";
/** Only paths on this site, anything else gives `fallback` */
export function returnPath(value: string | null | undefined, fallback = "/user"): string {
    if (!value?.startsWith("/")) return fallback;
    const url = new URL(value, LOCAL);
    // stops //host and /\host leaving the site
    return url.origin === LOCAL ? `${url.pathname}${url.search}` : fallback;
}

// used to drop the readonly modifier
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Tuple = <T extends [any, ...any]>(v: T): T => v;
