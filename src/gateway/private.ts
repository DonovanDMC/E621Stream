import Debug from "@yiffy/debug";

import { privatePollIntervalMS, redisPrefix } from "../config.ts";
import { AuthError, createClient, privateQueue, request } from "../e621.ts";
import { PRIVATE_EVENT_TYPES, type PrivateEventType } from "../events.ts";
import { count } from "../metrics.ts";
import redis, { createRedis } from "../redis.ts";

import type { Credentials } from "./auth.ts";
import type E621 from "e621";

interface Item { created_at?: string; id: number }
type Page = `${"a" | "b"}${number}`;

const SOURCES: Record<PrivateEventType, (client: E621, page: Page) => Promise<Array<Item>>> = {
    // this includes sent dmails too
    "dmail.create": (client, page) => client.dmails.search({ limit: LIMIT, page }),
};

export interface PrivateMember {
    credentials: Credentials;
    privateTypes: Set<PrivateEventType>;
    userId: number;
    deliverPrivate(type: PrivateEventType, data: Item): void;
}

const LIMIT = 320;
const MAX_PAGES = 5;
const MAX_ID = 2_147_483_647;
const TICK_MS = 5000;
const CURSOR_TTL_SECONDS = 90 * 24 * 60 * 60;
const channel = `${redisPrefix}:private`;
const gatewayId = crypto.randomUUID();

const cursorKey = (type: PrivateEventType, userId: number): string => `${redisPrefix}:private:${type}:${userId}`;
const lockKey = (type: PrivateEventType, userId: number): string => `${redisPrefix}:private:lock:${type}:${userId}`;

const members = new Map<number, Set<PrivateMember>>();
const lastPolled = new Map<string, number>();

export function updatePrivate(member: PrivateMember): void {
    let set = members.get(member.userId);
    if (member.privateTypes.size === 0) {
        set?.delete(member);
        if (set?.size === 0) members.delete(member.userId);
        return;
    }
    if (!set) members.set(member.userId, set = new Set());
    set.add(member);
}

export function removePrivate(member: PrivateMember): void {
    const set = members.get(member.userId);
    set?.delete(member);
    if (set?.size === 0) members.delete(member.userId);
}

async function own(type: PrivateEventType, userId: number): Promise<boolean> {
    const key = lockKey(type, userId), ttl = String(privatePollIntervalMS * 3);
    if (await redis.send("SET", [key, gatewayId, "NX", "PX", ttl]) === "OK") return true;
    if (await redis.get(key) !== gatewayId) return false;
    await redis.send("PEXPIRE", [key, ttl]);
    return true;
}

async function poll(type: PrivateEventType, userId: number, credentials: Credentials): Promise<void> {
    const client = createClient(credentials.username, credentials.apiKey);
    const search = (page: Page): Promise<Array<Item>> => {
        count("requests.private");
        return request(`${type} for ${credentials.username}`, () => SOURCES[type](client, page), privateQueue, 2);
    };
    const key = cursorKey(type, userId);
    const stored = await redis.get(key);
    if (stored === null) {
        const [newest] = await search(`b${MAX_ID}`);
        await redis.set(key, String(newest?.id ?? 0), "EX", CURSOR_TTL_SECONDS);
        return;
    }
    let cursor = Number(stored);
    for (let page = 0; page < MAX_PAGES; page++) {
        const items = (await search(`a${cursor}`)).sort((a, b) => a.id - b.id);
        for (const item of items) await redis.publish(channel, JSON.stringify({ user_id: userId, type, data: item }));
        if (items.length !== 0) cursor = items.at(-1)!.id;
        if (items.length < LIMIT) break;
    }
    await redis.set(key, String(cursor), "EX", CURSOR_TTL_SECONDS);
}

async function tick(): Promise<void> {
    for (const [userId, set] of members) {
        const member = set.values().next().value;
        if (!member) continue;
        const types = new Set([...set].flatMap(m => [...m.privateTypes]));
        for (const type of types) {
            const key = `${type}:${userId}`;
            if (Date.now() - (lastPolled.get(key) ?? 0) < privatePollIntervalMS) continue;
            lastPolled.set(key, Date.now());
            try {
                if (await own(type, userId)) await poll(type, userId, member.credentials);
            } catch (err) {
                if (!(err instanceof AuthError)) Debug("gateway:private", `${type} for user ${userId} failed: ${String(err)}`);
            }
        }
    }
    for (const key of lastPolled.keys()) if (!members.has(Number(key.split(":").at(-1)))) lastPolled.delete(key);
}

export async function startPrivate(): Promise<void> {
    const subscriber = createRedis();
    await subscriber.subscribe(channel, (message) => {
        const { data, type, user_id: userId } = JSON.parse(message) as { data: Item; type: PrivateEventType; user_id: number };
        if (!PRIVATE_EVENT_TYPES.includes(type)) return;
        for (const member of members.get(userId) ?? []) member.deliverPrivate(type, data);
    });
    const loop = async (): Promise<void> => {
        await tick().catch((err: unknown) => { Debug("gateway:private", `poll round failed: ${String(err)}`); });
        setTimeout(() => void loop(), TICK_MS);
    };
    void loop();
}
