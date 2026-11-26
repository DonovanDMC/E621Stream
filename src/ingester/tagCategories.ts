import Debug from "@yiffy/debug";
import { TagCategorySchema } from "e621-openapi/schemas";

import DB from "../db/DB.ts";
import Backfill from "../db/models/Backfill.ts";
import { e621, request } from "../util/e621.ts";

import type { Scheduler } from "../util/RequestQueue.ts";
import type * as E621 from "e621-openapi/types";

// the spec names each id
const CATEGORIES = new Map<number, E621.TagCategoryNames>(TagCategorySchema.enum.map((id, i) => [id, TagCategorySchema["x-enum-varnames"][i]!]));
type Categories = E621.ExtendedPost["tags"];

// names per tag search, the names all go in the url
const LOOKUP_CHUNK = 100;
// tags we had to ask e621 about, so the same new tag isn't looked up every poll until the tags feed stores it
const LOOKED_UP_MS = 10 * 60_000;
const lookedUp = new Map<string, { at: number; category: number }>();

export type Lookup = (names: Array<string>) => Promise<Array<Pick<E621.Tag, "category" | "name">>>;
const searchTags: Lookup = async (names) => {
    const found: Array<Pick<E621.Tag, "category" | "name">> = [];
    for (let i = 0; i < names.length; i += LOOKUP_CHUNK) {
        const chunk = names.slice(i, i + LOOKUP_CHUNK);
        found.push(...await request("tags by name", () => e621.tags.search({ name: chunk.join(","), limit: chunk.length })));
    }
    return found;
};

/** Our stored categories for these names, ones we don't have are left out */
async function storedCategories(names: Array<string>): Promise<Map<string, number>> {
    if (names.length === 0) return new Map();
    // uses the snapshots_tag_name index
    const rows = await DB<Array<{ category: string; name: string }>>`
        SELECT data->>'name' AS name, data->>'category' AS category FROM snapshots
        WHERE resource = 'tag' AND data->>'name' = ANY(${DB.array(names, "TEXT")})
    `;
    return new Map(rows.map(row => [row.name, Number(row.category)]));
}

/**
 * Basic posts' tags put into categories like an extended post's, from the tags we've stored.
 * The few we don't have yet, like ones made by the edit being looked at, are asked for in one search.
 * Without a lookup they're general, the backfill doesn't look them up since tags it's missing are ones e621's tag search doesn't have either
 */
export async function categorize(posts: Array<E621.BasicPost>, lookup: Lookup | null = searchTags): Promise<Array<E621.ExtendedPost>> {
    const names = [...new Set(posts.flatMap(post => post.tags))];
    const categories = await storedCategories(names);
    const now = Date.now();
    for (const [name, entry] of lookedUp) {
        if (now - entry.at > LOOKED_UP_MS) lookedUp.delete(name);
        else if (!categories.has(name)) categories.set(name, entry.category);
    }
    const missing = names.filter(name => !categories.has(name));
    if (missing.length !== 0 && lookup) {
        Debug("ingester:tags", `looking up ${missing.length} tag(s) we don't have`);
        const found = await lookup(missing);
        for (const name of missing) {
            // ones e621 didn't find are remembered too, so they aren't asked about every time they show up
            const category = found.find(tag => tag.name === name)?.category ?? 0;
            categories.set(name, category);
            lookedUp.set(name, { at: now, category });
        }
    }
    return posts.map((post) => {
        const tags = Object.fromEntries([...CATEGORIES.values()].map(category => [category, []])) as unknown as Categories;
        // anything e621 didn't find either is treated like a new tag, which is general
        for (const name of post.tags) tags[CATEGORIES.get(categories.get(name) ?? 0) ?? "general"].push(name);
        return { ...post, tags };
    });
}

let basicAllowed = false;
let checkedAt = 0;
const CHECK_MS = 60_000;
/** Basic posts need nearly every tag stored already, which the tags backfill does, until then posts are fetched extended */
export async function useBasicPosts(): Promise<boolean> {
    if (basicAllowed) return true;
    if (Date.now() - checkedAt < CHECK_MS) return false;
    checkedAt = Date.now();
    basicAllowed = (await Backfill.find("tags"))?.status === "done";
    if (basicAllowed) Debug("ingester:tags", "the tags backfill is done, posts are fetched basic from now on");
    return basicAllowed;
}

/**
 * Posts with their tags in categories, basic when it can be since that's lighter on e621.
 * Makes its own request, don't call it inside one: looking up tags while holding a request's slot deadlocked the queue
 */
export async function searchPosts(description: string, options: { limit: number; page: number | `b${number}`; tags: string }, queue?: Scheduler, lookupTags = true): Promise<Array<E621.ExtendedPost>> {
    if (await useBasicPosts()) {
        const posts = await request(description, async () => e621.posts.search({ ...options, mode: "basic" }), queue);
        return categorize(posts, lookupTags ? searchTags : null);
    }
    return request(description, async () => e621.posts.search({ ...options, mode: "extended" }), queue);
}
