import { RedisClient } from "bun";

import { redisURL } from "./config.ts";

export function createRedis(): RedisClient {
    return new RedisClient(redisURL, { autoReconnect: true, maxRetries: 4_294_967_295, enableOfflineQueue: true });
}

// shared connection for normal commands, anything that blocks (XREAD BLOCK) needs its own
const redis = createRedis();
export default redis;

export type StreamEntry = [id: string, fields: Array<string>];

export function fieldsToObject(fields: Array<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) out[fields[i]!] = fields[i + 1]!;
    return out;
}
