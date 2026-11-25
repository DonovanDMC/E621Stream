import Debug from "@yiffy/debug";

import Config from "../Config.ts";
import GatewayToken from "../db/models/GatewayToken.ts";
import OAuthLink from "../db/models/OAuthLink.ts";
import Redis from "../db/Redis.ts";
import { parseToken } from "../http/OAuth.tsx";
import { authQueue, createClient, request } from "../util/e621.ts";
import { AuthError } from "../util/errors.ts";
import { fingerprint } from "../util/HMAC.ts";
import I18n from "../util/I18n.ts";

const NEGATIVE_CACHE_SECONDS = 300;
const cacheKey = (credentials: APIKeyCredentials): string => `${Config.redisPrefix}atuh:${fingerprint(`${credentials.username.toLowerCase()}:${credentials.apiKey}`)}`;

export interface E621User {
    id: number;
    level: number;
    level_string: string;
    name: string;
}

export interface TokenCredentials { token: string }
export interface APIKeyCredentials { apiKey: string; username: string }
export type Credentials = TokenCredentials | APIKeyCredentials;

function parseBasicAuthHeader(header: string): APIKeyCredentials | null {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    const [username, apiKey] = decoded.split(":");
    if (!username || !apiKey) return null;
    return { apiKey, username };
}

function parseTokenAuthHeader(header: string): TokenCredentials | null {
    const token = parseToken(header);
    return token ? { token } : null;
}

export function parseAuthHeader(header: string | null): Credentials | null {
    if (header === null || header.trim() === "") return null;
    if (header.toLowerCase().startsWith("basic ")) return parseBasicAuthHeader(header.slice(6).trim());
    if (header.toLowerCase().startsWith("bearer ")) return parseTokenAuthHeader(header.slice(7).trim());
    return null;
}

export type VerifyResult = { ok: false; reason: string } | { ok: true; private: boolean; user: E621User };
export async function verify(credentials: Credentials): Promise<VerifyResult> {
    if ("token" in credentials) return verifyToken(credentials.token);
    const key = cacheKey(credentials);
    const cached = await Redis.get(key);
    if (cached !== null) {
        const result = JSON.parse(cached) as VerifyResult;
        return result.ok ? { ...result, private: true } : result;
    }

    let result: VerifyResult;
    try {
        const me = await request("users.me", () => createClient({ authUser: credentials.username, authKey: credentials.apiKey }).users.me(), authQueue, 2);
        result = me.is_banned
            ? { ok: false, reason: I18n.t("gateway.auth.banned") }
            : { ok: true, private: true, user: { id: me.id, name: me.name, level: me.level, level_string: me.level_string } };
    } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        result = { ok: false, reason: I18n.t("gateway.auth.credentials") };
    }
    Debug("gateway:auth", `checked ${credentials.username} with e621, got: ${result.ok ? `https://e621.net/users/${result.user.id}` : result.reason}`);
    await Redis.set(key, JSON.stringify(result), "EX", result.ok ? Config.authCacheSeconds : NEGATIVE_CACHE_SECONDS);
    return result;
}

async function verifyToken(token: string): Promise<VerifyResult> {
    const gwt = await GatewayToken.findByToken(token);
    if (!gwt) return { ok: false, reason: I18n.t("gateway.auth.credentials") };
    // the server keeps links refreshed and the user's info up to date, a missing one was revoked
    const link = await OAuthLink.findBy({ user_id: gwt.user_id });
    if (!link) return { ok: false, reason: I18n.t("gateway.auth.revoked") };
    if (link.cached_data.banned) return { ok: false, reason: I18n.t("gateway.auth.banned") };
    await gwt.update({ last_used_at: new Date() });
    return { ok: true, private: link.full && gwt.private_events, user: link.cached_data.user };
}
