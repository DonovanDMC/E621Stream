import Debug from "@yiffy/debug";

import Config from "../Config.ts";
import OAuthLink from "../db/models/OAuthLink.ts";
import Redis, { createRedis } from "../db/Redis.ts";
import { createClient, privateQueue, request, type E621Client } from "../util/e621.ts";
import { AuthError } from "../util/errors.ts";
import { count } from "../util/metrics.ts";

import { PRIVATE_EVENT_TYPES, type PrivateEventType, type PrivateEventTypeDataMap } from "./events.ts";

import type { Credentials } from "./auth.ts";

export interface PrivateEvent<T extends PrivateEventType = PrivateEventType> {
    data: PrivateEventTypeDataMap[T];
    id: string;
    recovered: boolean;
    time: string; // ISO timestamp
    type: T;
}

export interface PrivateMember {
    credentials: Credentials;
    privateTypes: Array<PrivateEventType>;
    userID: number;
    deliverPrivate(event: PrivateEvent): Promise<boolean>;
}

type Search = <T>(fn: (client: E621Client) => Promise<T>) => Promise<T>;
interface Source {
    types: Array<PrivateEventType>;
    poll(search: Search, userID: number): Promise<Array<PrivateEvent>>;
}

const LIMIT = 320;
const MAX_PAGES = 5;
const MAX_ID = 2_147_483_647;
const TICK_MS = 5000;
// where each user was up to, kept a while so reconnecting doesn't skip what was missed
const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;
const channel = `${Config.redisPrefix}private`;
const gatewayID = crypto.randomUUID();

const stateKey = (source: string, userID: number): string => `${Config.redisPrefix}private:${source}:${userID}`;
const lockKey = (source: string, userID: number): string => `${Config.redisPrefix}private:lock:${source}:${userID}`;
const event = <T extends PrivateEventType>(type: T, id: string, time: string, data: PrivateEventTypeDataMap[T]): PrivateEvent => ({ type, id, time, data, recovered: false });

// this includes sent dmails too
async function dmails(search: Search, userID: number): Promise<Array<PrivateEvent>> {
    const key = stateKey("dmail.create", userID);
    const stored = await Redis.get(key);
    if (stored === null) {
        const [newest] = await search(client => client.dmails.search({ limit: 1, page: `b${MAX_ID}` }));
        await Redis.set(key, String(newest?.id ?? 0), "EX", STATE_TTL_SECONDS);
        return [];
    }
    const events: Array<PrivateEvent> = [];
    let cursor = Number(stored);
    for (let page = 0; page < MAX_PAGES; page++) {
        const items = (await search(client => client.dmails.search({ limit: LIMIT, page: `a${cursor}` }))).sort((a, b) => a.id - b.id);
        for (const item of items) events.push(event("dmail.create", `dmail.create:${item.id}`, item.created_at, item));
        if (items.length !== 0) cursor = items.at(-1)!.id;
        if (items.length < LIMIT) break;
    }
    await Redis.set(key, String(cursor), "EX", STATE_TTL_SECONDS);
    return events;
}

// what each set had last time, the changes are the events
async function privateSets(search: Search, userID: number): Promise<Array<PrivateEvent>> {
    const key = stateKey("private_post_set", userID);
    const known = new Map(Object.entries(await Redis.hgetall(key)).map(([id, raw]) => [id, JSON.parse(raw) as { post_ids: Array<number>; updated_at: string }]));
    // users can only have 75 sets, so one page is all of them
    const sets = (await search(client => client.postSets.search({ creator_id: userID, limit: LIMIT }))).filter(set => !set.is_public);
    const events: Array<PrivateEvent> = [], changed: Record<string, string> = {};
    for (const set of sets) {
        const before = known.get(String(set.id));
        known.delete(String(set.id));
        if (before?.updated_at === set.updated_at) continue;
        changed[String(set.id)] = JSON.stringify({ post_ids: set.post_ids, updated_at: set.updated_at });
        // a set we haven't seen yet is only remembered
        if (!before) continue;
        const added = set.post_ids.filter(id => !before.post_ids.includes(id)), removed = before.post_ids.filter(id => !set.post_ids.includes(id));
        const at = Date.parse(set.updated_at);
        if (added.length !== 0) events.push(event("private_post_set.add_posts", `private_post_set.add_posts:${set.id}:${at}`, set.updated_at, set));
        if (removed.length !== 0) events.push(event("private_post_set.remove_posts", `private_post_set.remove_posts:${set.id}:${at}`, set.updated_at, set));
    }
    // ones that are gone, or were made public
    if (known.size !== 0) await Redis.hdel(key, ...[...known.keys()] as [string, ...Array<string>]);
    if (Object.keys(changed).length !== 0) await Redis.hset(key, changed);
    await Redis.expire(key, STATE_TTL_SECONDS);
    return events.sort((a, b) => a.time.localeCompare(b.time));
}

const SOURCES: Record<string, Source> = {
    "dmail.create": { types: ["dmail.create"], poll: dmails },
    "private_post_set": { types: ["private_post_set.add_posts", "private_post_set.remove_posts"], poll: privateSets },
};
const sourceOf = (type: PrivateEventType): string => Object.entries(SOURCES).find(([, source]) => source.types.includes(type))![0];

const members = new Map<number, Array<PrivateMember>>();
const lastPolled = new Map<string, number>();

export function updatePrivate(member: PrivateMember): void {
    if (member.privateTypes.length === 0) {
        removePrivate(member);
        return;
    }
    const forUser = members.get(member.userID) ?? [];
    if (!forUser.includes(member)) members.set(member.userID, [...forUser, member]);
}

export function removePrivate(member: PrivateMember): void {
    const forUser = members.get(member.userID)?.filter(m => m !== member) ?? [];
    if (forUser.length === 0) members.delete(member.userID);
    else members.set(member.userID, forUser);
}

// every gateway with the user's sessions would poll otherwise, the lock lets one do it
async function own(source: string, userID: number): Promise<boolean> {
    const key = lockKey(source, userID), ttl = Config.e621PrivatePollInterval * 3;
    if (await Redis.send("SET", [key, gatewayID, "NX", "PX", String(ttl)]) === "OK") return true;
    if (await Redis.get(key) !== gatewayID) return false;
    await Redis.pexpire(key, ttl);
    return true;
}

async function clientFor(credentials: Credentials, userID: number, description: string): Promise<E621Client> {
    if ("apiKey" in credentials) return createClient({ authUser: credentials.username, authKey: credentials.apiKey });
    // gateway tokens poll with the user's oauth link, which the server keeps refreshed.
    // an expired one means it's behind, it's tried again next round
    const link = await OAuthLink.findBy({ user_id: userID });
    if (!link || link.expires_at.getTime() <= Date.now()) throw new AuthError(description, 401);
    return createClient({ authToken: link.oauthToken.access_token });
}

async function poll(name: string, userID: number, credentials: Credentials): Promise<void> {
    const description = `${name} for #${userID}`;
    const search: Search = async (fn) => {
        const client = await clientFor(credentials, userID, description);
        count("requests.private");
        return request(description, () => fn(client), privateQueue, 2);
    };
    for (const found of await SOURCES[name]!.poll(search, userID)) await Redis.publish(channel, JSON.stringify({ user_id: userID, ...found }));
}

async function tick(): Promise<void> {
    for (const [userID, forUser] of members) {
        const [member] = forUser;
        if (!member) continue;
        const sources = [...new Set(forUser.flatMap(m => m.privateTypes.map(sourceOf)))];
        for (const name of sources) {
            const key = `${name}:${userID}`;
            if (Date.now() - (lastPolled.get(key) ?? 0) < Config.e621PrivatePollInterval) continue;
            lastPolled.set(key, Date.now());
            try {
                if (await own(name, userID)) await poll(name, userID, member.credentials);
            } catch (err) {
                // revoked access is noticed by the session's auth recheck, which closes it
                if (!(err instanceof AuthError)) Debug("gateway:private", `${name} for #${userID} failed: ${String(err)}`);
            }
        }
    }
    for (const key of lastPolled.keys()) if (!members.has(Number(key.split(":").at(-1)))) lastPolled.delete(key);
}

/** Polls for the private events of users connected here, and delivers ones any gateway finds */
export async function startPrivate(): Promise<void> {
    // subscribing takes over the connection, so it needs its own
    const subscriber = createRedis();
    await subscriber.subscribe(channel, (message) => {
        const { user_id: userID, ...found } = JSON.parse(message) as PrivateEvent & { user_id: number };
        if (!PRIVATE_EVENT_TYPES.includes(found.type)) return;
        for (const member of members.get(userID) ?? []) void member.deliverPrivate(found).catch(() => false);
    });
    const loop = async (): Promise<void> => {
        await tick().catch((err: unknown) => { Debug("gateway:private", `poll round failed: ${String(err)}`); });
        setTimeout(() => void loop(), TICK_MS);
    };
    void loop();
}
