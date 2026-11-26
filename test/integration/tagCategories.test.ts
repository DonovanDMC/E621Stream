import { beforeEach, expect, test } from "bun:test";

import Backfill from "../../src/db/models/Backfill.ts";
import { saveSnapshots } from "../../src/gateway/snapshots.ts";
import { categorize, type Lookup } from "../../src/ingester/tagCategories.ts";
import { reset } from "../helpers.ts";

import type * as E621 from "e621-openapi/types";

beforeEach(reset);

const tag = (id: number, name: string, category: number): never => ({ id, name, category, post_count: 1, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }) as never;
const post = (id: number, tags: Array<string>): E621.BasicPost => ({ id, tags } as never);
const empty = { general: [], artist: [], contributor: [], copyright: [], character: [], species: [], invalid: [], meta: [], lore: [] };

test("tags are put in their categories from what's stored, in the order they came", async () => {
    await saveSnapshots("tag", [tag(1, "fox", 5), tag(2, "solo", 0), tag(3, "someone", 1), tag(4, "hi_res", 7)]);
    const asked: Array<Array<string>> = [];
    const lookup: Lookup = async (names) => {
        asked.push(names);
        return [];
    };
    const [result] = await categorize([post(1, ["fox", "hi_res", "solo", "someone"])], lookup);
    expect(result!.tags).toEqual({ ...empty, general: ["solo"], artist: ["someone"], species: ["fox"], meta: ["hi_res"] });
    expect(asked).toEqual([]);
});

test("ones we don't have are looked up once, and remembered for a while", async () => {
    await saveSnapshots("tag", [tag(1, "fox", 5)]);
    const asked: Array<Array<string>> = [];
    const lookup: Lookup = async (names) => {
        asked.push(names);
        return names.filter(name => name === "new_artist").map(name => ({ name, category: 1 as const }));
    };
    const [first] = await categorize([post(1, ["fox", "new_artist", "gone_tag"])], lookup);
    expect(first!.tags).toMatchObject({ species: ["fox"], artist: ["new_artist"], general: ["gone_tag"] });
    await categorize([post(2, ["new_artist"])], lookup);
    // gone_tag isn't asked about again either, even though e621 didn't have it
    expect(asked).toEqual([["new_artist", "gone_tag"]]);
    await categorize([post(3, ["gone_tag"])], lookup);
    expect(asked).toHaveLength(1);
});

test("without a lookup, ones we don't have are general", async () => {
    await saveSnapshots("tag", [tag(1, "fox", 5)]);
    const [result] = await categorize([post(1, ["fox", "unknown_tag"])], null);
    expect(result!.tags).toMatchObject({ species: ["fox"], general: ["unknown_tag"] });
});

test("the rest of the post is kept", async () => {
    const [result] = await categorize([{ ...post(5, []), rating: "s", change_seq: 9 } as never], async () => []);
    expect(result).toMatchObject({ id: 5, rating: "s", change_seq: 9, tags: empty });
});

test("basic posts wait for the tags backfill", async () => {
    // a fresh module, so the last check isn't cached
    const { useBasicPosts } = await import(`../../src/ingester/tagCategories.ts?fresh=${Date.now()}`) as typeof import("../../src/ingester/tagCategories.ts");
    expect(await useBasicPosts()).toBe(false);
    await Backfill.create({ source: "tags", kind: "crawl", status: "done" } as never);
    const again = await import(`../../src/ingester/tagCategories.ts?fresh=${Date.now() + 1}`) as typeof import("../../src/ingester/tagCategories.ts");
    expect(await again.useBasicPosts()).toBe(true);
});
