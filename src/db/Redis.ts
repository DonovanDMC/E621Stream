import Config from "../Config.ts";

import type { StreamItem } from "../gateway/events.ts";

export function createRedis(): Bun.RedisClient {
    return new Bun.RedisClient(Config.redisURL, { autoReconnect: true, maxRetries: 4_294_967_295, enableOfflineQueue: true, connectionTimeout: 2000 });
}

const Redis = createRedis();
export default Redis;

export type StreamEntry = [id: string, fields: Array<string>];
export function fieldsToObject(fields: Array<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i += 2) {
        const name = fields[i]!, type = fields[i + 1]!.split(":")[0]!, value = fields[i + 1]!.split(":").slice(1).join(":");
        switch (type) {
            case "string": out[name] = value; break;
            case "number": out[name] = Number(value); break;
            case "boolean": out[name] = value === "true"; break;
            case "object": out[name] = JSON.parse(value); break;
            default: {
                throw new Error(`not sure how to convert ${type}: ${name}/${value}`);
            }
        }
    }
    return out;
}

export function objectToFields(object: Record<string, unknown>): Array<string> {
    const out: Array<string> = [];
    for (const [name, value] of Object.entries(object)) {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        out.push(name, `${typeof value}:${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    return out;
}

export function parseEntry([id, fields]: StreamEntry): StreamItem | null {
    // the id isn't stored in the fields, it's the entry's
    const event = { ...fieldsToObject(fields), id };
    return event as unknown as StreamItem;
}
