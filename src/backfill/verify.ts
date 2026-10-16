import Debug from "@yiffy/debug";

import { getSnapshots } from "../db.ts";
import { backfillQueue, e621, request } from "../e621.ts";
import { snapshot, type Post } from "../ingester/posts.ts";
import { pick, TRACKED, type Item, type Tracked } from "../ingester/updates.ts";

function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === "object") {
        const entries = Object.entries(value).filter(([, v]) => !(Array.isArray(v) && v.length === 0));
        return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]));
    }
    return value;
}

function compare(name: string, records: Array<{ current: Record<string, unknown>; id: number }>, stored: Map<number, Record<string, unknown>>): void {
    const mismatches = new Map<string, { count: number; example: string }>();
    let missing = 0, checked = 0;
    for (const { current, id } of records) {
        const before = stored.get(id);
        if (!before) {
            missing++;
            continue;
        }
        checked++;
        for (const field of new Set([...Object.keys(current), ...Object.keys(before)])) {
            const a = JSON.stringify(normalize(before[field] ?? null)), b = JSON.stringify(normalize(current[field] ?? null));
            if (a === b) continue;
            const entry = mismatches.get(field) ?? { count: 0, example: `#${id}: stored ${a.slice(0, 200)}, e621 has ${b.slice(0, 200)}` };
            entry.count++;
            mismatches.set(field, entry);
        }
    }
    Debug("backfill:verify", `${name}: ${checked} compared, ${missing} not stored`);
    for (const [field, { count, example }] of mismatches) Debug("backfill:verify", `  ${field}: ${count} differ, e.g. ${example}`);
}

async function verifyPosts(): Promise<void> {
    // random posts are mostly old, some will have changed since the export
    const posts = await request("verify posts", () => e621.posts.search({ tags: "order:random status:any", limit: 320 }), backfillQueue) as Array<unknown> as Array<Post>;
    const stored = await getSnapshots("post", posts.map(post => post.id));
    compare("posts", posts.map(post => ({ id: post.id, current: snapshot(post) as unknown as Record<string, unknown> })), stored);
}

async function verifyTracked(name: string, tracked: Tracked, search: () => Promise<Array<Item> | null>): Promise<void> {
    const items = await request(`verify ${name}`, search, backfillQueue) ?? [];
    const stored = await getSnapshots(tracked.resource, items.map(item => item.id));
    compare(name, items.map(item => ({ id: item.id, current: pick(tracked, item) })), stored);
}

export async function verify(): Promise<void> {
    await verifyPosts();
    await verifyTracked("tag_aliases", TRACKED.tagAlias, () => e621.tagAliases.search({ limit: 320, page: "a0" }));
    await verifyTracked("tag_implications", TRACKED.tagImplication, () => e621.tagImplications.search({ limit: 320, page: "a0" }));
    await verifyTracked("bulk_update_requests", TRACKED.bulkUpdateRequest, () => e621.bulkUpdateRequests.search({ limit: 320, page: "a0" }));
}
