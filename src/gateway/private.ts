import Debug from "@yiffy/debug";

import { privatePollIntervalMS, redisPrefix } from "../config.ts";
import { AuthError, createClient, privateQueue, request } from "../e621.ts";
import { PRIVATE_EVENT_TYPES, type PrivateEventType } from "../events.ts";
import { count } from "../metrics.ts";
import redis, { createRedis } from "../redis.ts";

import type { Credentials } from "./auth.ts";
import type E621 from "e621";

export interface PrivateEvent { data: unknown; id: string; time: string; type: PrivateEventType }

interface Source {
    types: Array<PrivateEventType>;
    poll(search: <T>(fn: (client: E621) => Promise<T>) => Promise<T>, userId: number): Promise<Array<PrivateEvent>>;
}

export interface PrivateMember {
    credentials: Credentials;
    privateTypes: Set<PrivateEventType>;
    userId: number;
    deliverPrivate(event: PrivateEvent): void;
}

const LIMIT = 320;
const MAX_PAGES = 5;
const MAX_ID = 2_147_483_647;
const TICK_MS = 5000;
const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;
const channel = `${redisPrefix}:private`;
const gatewayId = crypto.randomUUID();

const stateKey = (source: string, userId: number): string => `${redisPrefix}:private:${source}:${userId}`;
const lockKey = (source: string, userId: number): string => `${redisPrefix}:private:lock:${source}:${userId}`;

async function dmails(search: Parameters<Source["poll"]>[0], userId: number): Promise<Array<PrivateEvent>> {
    const key = stateKey("dmail.create", userId);
    const stored = await redis.get(key);
    if (stored === null) {
        const [newest] = await search(client => client.dmails.search({ limit: LIMIT, page: `b${MAX_ID}` }));
        await redis.set(key, String(newest?.id ?? 0), "EX", STATE_TTL_SECONDS);
        return [];
    }
    const events: Array<PrivateEvent> = [];
    let cursor = Number(stored);
    for (let page = 0; page < MAX_PAGES; page++) {
        // this includes sent dmails too
        const items = (await search(client => client.dmails.search({ limit: LIMIT, page: `a${cursor}` }))).sort((a, b) => a.id - b.id);
        for (const item of items) events.push({ type: "dmail.create", id: `dmail.create:${item.id}`, time: item.created_at, data: item });
        if (items.length !== 0) cursor = items.at(-1)!.id;
        if (items.length < LIMIT) break;
    }
    await redis.set(key, String(cursor), "EX", STATE_TTL_SECONDS);
    return events;
}

export async function privateSets(search: Parameters<Source["poll"]>[0], userId: number, store: Pick<typeof redis, "send"> = redis): Promise<Array<PrivateEvent>> {
    const key = stateKey("private_post_set", userId);
    const known = new Map(Object.entries(await store.send("HGETALL", [key]) as Record<string, string> | null ?? {}).map(([id, raw]) => [id, JSON.parse(raw) as { post_ids: Array<number>; updated_at: string }]));
    // users can only have 75 sets, so one page is all of them
    const sets = (await search(client => client.postSets.search({ creator_id: userId, limit: LIMIT }))).filter(set => !set.is_public);
    const events: Array<PrivateEvent> = [], changed: Array<string> = [];
    for (const set of sets) {
        const before = known.get(String(set.id));
        known.delete(String(set.id));
        if (before?.updated_at === set.updated_at) continue;
        changed.push(String(set.id), JSON.stringify({ post_ids: set.post_ids, updated_at: set.updated_at }));
        // sets we've never seen are only stored, same as the public ones
        if (!before) continue;
        const was = new Set(before.post_ids), now = new Set(set.post_ids);
        const added = set.post_ids.filter(id => !was.has(id)), removed = before.post_ids.filter(id => !now.has(id));
        const at = Date.parse(set.updated_at);
        if (added.length !== 0) events.push({ type: "private_post_set.add_posts", id: `private_post_set.add_posts:${set.id}:${at}`, time: set.updated_at, data: { post_set: set, post_ids: added } });
        if (removed.length !== 0) events.push({ type: "private_post_set.remove_posts", id: `private_post_set.remove_posts:${set.id}:${at}`, time: set.updated_at, data: { post_set: set, post_ids: removed } });
    }
    // whatever's left was deleted or made public
    if (known.size !== 0) await store.send("HDEL", [key, ...known.keys()]);
    if (changed.length !== 0) await store.send("HSET", [key, ...changed]);
    await store.send("EXPIRE", [key, String(STATE_TTL_SECONDS)]);
    return events.sort((a, b) => a.time.localeCompare(b.time));
}

const SOURCES: Record<string, Source> = {
    "dmail.create": { types: ["dmail.create"], poll: dmails },
    "private_post_set": { types: ["private_post_set.add_posts", "private_post_set.remove_posts"], poll: privateSets },
};
const sourceOf = (type: PrivateEventType): string => Object.entries(SOURCES).find(([, source]) => source.types.includes(type))![0];

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

async function own(source: string, userId: number): Promise<boolean> {
    const key = lockKey(source, userId), ttl = String(privatePollIntervalMS * 3);
    if (await redis.send("SET", [key, gatewayId, "NX", "PX", ttl]) === "OK") return true;
    if (await redis.get(key) !== gatewayId) return false;
    await redis.send("PEXPIRE", [key, ttl]);
    return true;
}

async function poll(name: string, userId: number, credentials: Credentials): Promise<void> {
    const client = createClient(credentials.username, credentials.apiKey);
    const search = <T>(fn: (client: E621) => Promise<T>): Promise<T> => {
        count("requests.private");
        return request(`${name} for ${credentials.username}`, () => fn(client), privateQueue, 2);
    };
    for (const event of await SOURCES[name]!.poll(search, userId)) await redis.publish(channel, JSON.stringify({ user_id: userId, ...event }));
}

async function tick(): Promise<void> {
    for (const [userId, set] of members) {
        const member = set.values().next().value;
        if (!member) continue;
        const sources = new Set([...set].flatMap(m => [...m.privateTypes].map(sourceOf)));
        for (const name of sources) {
            const key = `${name}:${userId}`;
            if (Date.now() - (lastPolled.get(key) ?? 0) < privatePollIntervalMS) continue;
            lastPolled.set(key, Date.now());
            try {
                if (await own(name, userId)) await poll(name, userId, member.credentials);
            } catch (err) {
                if (!(err instanceof AuthError)) Debug("gateway:private", `${name} for user ${userId} failed: ${String(err)}`);
            }
        }
    }
    for (const key of lastPolled.keys()) if (!members.has(Number(key.split(":").at(-1)))) lastPolled.delete(key);
}

export async function startPrivate(): Promise<void> {
    const subscriber = createRedis();
    await subscriber.subscribe(channel, (message) => {
        const { user_id: userId, ...event } = JSON.parse(message) as PrivateEvent & { user_id: number };
        if (!PRIVATE_EVENT_TYPES.includes(event.type)) return;
        for (const member of members.get(userId) ?? []) member.deliverPrivate(event);
    });
    const loop = async (): Promise<void> => {
        await tick().catch((err: unknown) => { Debug("gateway:private", `poll round failed: ${String(err)}`); });
        setTimeout(() => void loop(), TICK_MS);
    };
    void loop();
}
