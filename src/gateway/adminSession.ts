import { adminSessionHours, redisPrefix, trustProxy } from "../config.ts";
import redis from "../redis.ts";

import type { E621User } from "./auth.ts";

export type Admin = Pick<E621User, "id" | "name">;

const COOKIE = "e621stream_admin";

export const sessionKey = (token: string): string => `${redisPrefix}:admin:${new Bun.CryptoHasher("sha256").update(token).digest("hex")}`;

export function sessionToken(req: Request): string | null {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
        const [name, ...value] = part.trim().split("=");
        if (name === COOKIE) return value.join("=") || null;
    }
    return null;
}

export function sessionCookie(req: Request, value: string, maxAge: number): string {
    const secure = new URL(req.url).protocol === "https:" || (trustProxy && req.headers.get("x-forwarded-proto") === "https");
    return `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** Logs someone in, returns the Set-Cookie header for it. */
export async function createSession(req: Request, admin: Admin): Promise<string> {
    const value = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    await redis.set(sessionKey(value), JSON.stringify(admin), "EX", adminSessionHours * 3600);
    return sessionCookie(req, value, adminSessionHours * 3600);
}
