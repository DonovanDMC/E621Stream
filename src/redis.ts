import { RedisClient } from "bun";

import { redisURL } from "./config.ts";

// a new connection. blocking reads (XREAD BLOCK) and pub/sub need their own, everything else shares the default one
// below. it retries forever so a redis restart doesn't take anything down with it
export function createRedis(): RedisClient {
    return new RedisClient(redisURL, { autoReconnect: true, maxRetries: 4_294_967_295, enableOfflineQueue: true });
}

const redis = createRedis();
export default redis;

// what XRANGE/XREAD give back for each entry. ids are `<ms>-<seq>`, ms being when it was added
export type StreamEntry = [id: string, fields: Array<string>];

// stream fields come back as a flat [key, value, key, value] list
export function fieldsToObject(fields: Array<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) out[fields[i]!] = fields[i + 1]!;
    return out;
}
