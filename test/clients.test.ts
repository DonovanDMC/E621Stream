import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { EVENT_TYPES, PRIVATE_EVENT_TYPES } from "../src/events.ts";

const read = (path: string): Promise<string> => Bun.file(resolve(import.meta.dir, "..", path)).text();
const quoted = (source: string): Array<string> => [...source.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map(match => match[1]!);
const between = (source: string, start: string, end: string): string => {
    const from = source.indexOf(start);
    return source.slice(from, source.indexOf(end, from));
};

describe("clients", () => {
    test("the typescript client has every event type", async () => {
        const source = await read("clients/typescript/lib/events.ts");
        expect(quoted(between(source, "export const EVENT_TYPES", "] as const;"))).toEqual([...EVENT_TYPES]);
        expect(quoted(between(source, "export const PRIVATE_EVENT_TYPES", "] as const;"))).toEqual([...PRIVATE_EVENT_TYPES]);
    });

    test("the typescript client knows what every event is sent with", async () => {
        const source = await read("clients/typescript/lib/generated.ts");
        const keys = [...between(source, "export interface EventDataMap", "\n}").matchAll(/^ {4}"([a-z_]+\.[a-z_]+)":/gm)].map(match => match[1]!);
        // bun run client-types
        expect(keys).toEqual([...EVENT_TYPES, ...PRIVATE_EVENT_TYPES]);
    });

    test("the ruby client has every event type", async () => {
        const source = await read("clients/ruby/lib/e621stream/events.rb");
        const words = (name: string): Array<string> => between(source, `${name} = %w[`, "]").slice(`${name} = %w[`.length).split(/\s+/).filter(Boolean);
        expect(words("EVENT_TYPES")).toEqual([...EVENT_TYPES]);
        expect(words("PRIVATE_EVENT_TYPES")).toEqual([...PRIVATE_EVENT_TYPES]);
    });
});
