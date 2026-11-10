import Debug from "@yiffy/debug";

import { authCacheSeconds, redisPrefix } from "../config.ts";
import { authQueue, AuthError, createClient, request } from "../e621.ts";
import redis from "../redis.ts";

export interface Credentials {
    apiKey: string;
    username: string;
}

export interface E621User {
    id: number;
    level: number;
    level_string: string;
    name: string;
}

export type VerifyResult = { ok: false; reason: string } | { ok: true; user: E621User };

// failures are cached too, so this can't be used to hammer e621
const NEGATIVE_CACHE_SECONDS = 300;

function cacheKey({ username, apiKey }: Credentials): string {
    return `${redisPrefix}:auth:${new Bun.CryptoHasher("sha256").update(`${username.toLowerCase()}:${apiKey}`).digest("hex")}`;
}

export function parseBasicAuth(header: string | null): Credentials | null {
    if (!header?.toLowerCase().startsWith("basic ")) return null;
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const split = decoded.indexOf(":");
    if (split <= 0) return null;
    return { username: decoded.slice(0, split), apiKey: decoded.slice(split + 1) };
}

export async function verify(credentials: Credentials): Promise<VerifyResult> {
    const key = cacheKey(credentials);
    const cached = await redis.get(key);
    if (cached !== null) return JSON.parse(cached) as VerifyResult;

    let result: VerifyResult;
    try {
        const me = await request("users.me", () => createClient(credentials.username, credentials.apiKey).users.me(), authQueue, 2);
        result = me.is_banned
            ? { ok: false, reason: "banned" }
            : { ok: true, user: { id: me.id, name: me.name, level: me.level, level_string: me.level_string } };
    } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        result = { ok: false, reason: "invalid credentials" };
    }
    Debug("gateway:auth", result.ok ? `checked ${credentials.username} with e621, they're #${result.user.id}` : `checked ${credentials.username} with e621: ${result.reason}`);
    await redis.set(key, JSON.stringify(result), "EX", result.ok ? authCacheSeconds : NEGATIVE_CACHE_SECONDS);
    return result;
}
