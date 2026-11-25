import Backfill from "../db/models/Backfill.ts";
import { getSnapshots } from "../gateway/snapshots.ts";
import { CRAWLS, runBackfill, type Crawl } from "../ingester/backfill.ts";
import { backfillQueue, request } from "../util/e621.ts";

export const usage = "backfill <status|reset <source...|all>|run <source...|all>|verify [source...]>";
export const description = "Checks on and runs the backfill. reset starts a source over, run goes until it's done or fails, verify compares what's stored with what e621 has now.";

const LIMIT = 320;
const MAX_ID = 2_147_483_647;
const EXAMPLE_LENGTH = 200;

// null when a name isn't a source
function pick(names: Array<string>, all = false): Array<Crawl> | null {
    const known = CRAWLS.map(source => source.name);
    const picked = names.includes("all") || (all && names.length === 0) ? known : names;
    const unknown = picked.filter(name => !known.includes(name));
    if (picked.length === 0 || unknown.length !== 0) {
        console.error(`unknown source(s): ${unknown.join(", ") || "(none given)"}\navailable: ${known.join(", ")}, all`);
        return null;
    }
    return CRAWLS.filter(source => picked.includes(source.name));
}

async function status(): Promise<void> {
    const states = await Backfill.all();
    for (const source of CRAWLS) {
        const state = states.find(s => s.source === source.name);
        // cursor is how many ids are left
        const progress = state?.ceiling ? ` ${Math.round(((state.ceiling - (state.cursor ?? state.ceiling)) / state.ceiling) * 100)}%` : "";
        console.log(`${source.name.padEnd(22)} ${(state?.status ?? "pending").padEnd(8)} ${String(state?.stored ?? 0).padStart(10)} stored${progress}${state?.error ? `  ${state.error}` : state?.detail ? `  ${state.detail}` : ""}`);
    }
}

// key order and the order of lists don't matter
function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalize(v)]));
    return value;
}

// a random page of what the backfill stored, or the newest page before it's started
async function verify(source: Crawl): Promise<void> {
    if (!source.resource) {
        console.log(`${source.name}: isn't stored as snapshots, skipped`);
        return;
    }
    const { resource } = source;
    const ceiling = (await Backfill.find(source.name))?.ceiling ?? null;
    const before = ceiling === null ? MAX_ID : Math.floor(Math.random() * ceiling) + LIMIT;
    const items = await request(`verify ${source.name}`, () => source.search({ limit: LIMIT, page: `b${before}` }), backfillQueue);
    const stored = await getSnapshots(resource, items.map(item => item.id));
    const differ = new Map<string, { count: number; example: string }>();
    let missing = 0;
    for (const item of items) {
        const known = stored.get(item.id)?.data as Record<string, unknown> | undefined;
        if (!known) {
            missing++;
            continue;
        }
        // only what we store is compared, like comment votes aren't
        for (const field of Object.keys(known)) {
            const a = JSON.stringify(normalize(known[field] ?? null)), b = JSON.stringify(normalize((item as unknown as Record<string, unknown>)[field] ?? null));
            if (a === b) continue;
            const entry = differ.get(field) ?? { count: 0, example: `#${item.id}: stored ${a.slice(0, EXAMPLE_LENGTH)}, e621 has ${b.slice(0, EXAMPLE_LENGTH)}` };
            entry.count++;
            differ.set(field, entry);
        }
    }
    console.log(`${source.name}: ${items.length - missing} compared, ${missing} not stored`);
    for (const [field, { count, example }] of differ) console.log(`  ${field}: ${count} differ, e.g. ${example}`);
}

/** false when the arguments were wrong */
export async function run(args: Array<string>): Promise<boolean> {
    const [command, ...names] = args;
    switch (command) {
        case "status": {
            await status();
            return true;
        }
        case "reset": {
            const sources = pick(names);
            if (!sources) return false;
            for (const source of sources) {
                await (await Backfill.find(source.name))?.destroy();
                console.log(`${source.name} reset`);
            }
            return true;
        }
        case "run": {
            const sources = pick(names);
            if (!sources) return false;
            for (const source of sources) console.log(`${source.name}: ${await runBackfill(source) ? "done" : "not done, see the logs"}`);
            return true;
        }
        case "verify": {
            const sources = pick(names, true);
            if (!sources) return false;
            for (const source of sources) await verify(source);
            return true;
        }
        default: {
            return false;
        }
    }
}
