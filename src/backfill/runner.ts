import Debug from "@yiffy/debug";

import { crawl, CRAWLS } from "./crawl.ts";
import { importPosts, importRequests } from "./exports.ts";
import { getState, setState, type BackfillState } from "./state.ts";

export interface Source {
    kind: BackfillState["kind"];
    name: string;
    run(): Promise<boolean>;
}

export const EXPORTS: Array<Source> = [
    { kind: "export", name: "tag_aliases", run: () => importRequests("tag_aliases").then(() => true) },
    { kind: "export", name: "tag_implications", run: () => importRequests("tag_implications").then(() => true) },
    { kind: "export", name: "bulk_update_requests", run: () => importRequests("bulk_update_requests").then(() => true) },
    { kind: "export", name: "posts", run: () => importPosts().then(() => true) },
];
export const CRAWL_SOURCES: Array<Source> = CRAWLS.map(source => ({ kind: "crawl", name: source.name, run: () => crawl(source) }));
export const SOURCES = [...EXPORTS, ...CRAWL_SOURCES];

const RETRY_MS = 5 * 60_000;
const IDLE_MS = 60 * 60_000;

export async function runSource(source: Source): Promise<boolean> {
    if ((await getState(source.name))?.status === "done") return false;
    const start = Date.now();
    try {
        if (source.kind === "export") await setState(source.name, "export", { status: "running", error: null, started_at: new Date() });
        if (!await source.run()) return true;
        if (source.kind === "export") await setState(source.name, "export", { status: "done", finished_at: new Date() });
        Debug("backfill", `${source.name} finished in ${Math.round((Date.now() - start) / 1000)}s`);
        return false;
    } catch (err) {
        Debug("backfill", `${source.name} failed, trying again in ${RETRY_MS / 60_000} minutes: ${String(err)}`);
        await setState(source.name, source.kind, { status: "failed", error: String(err) }).catch(() => null);
        return true;
    }
}

async function loop(sources: Array<Source>): Promise<never> {
    for (;;) {
        let pending = false;
        for (const source of sources) if (await runSource(source)) pending = true;
        await Bun.sleep(pending ? RETRY_MS : IDLE_MS);
    }
}

export function startBackfill(): void {
    for (const source of SOURCES) void setState(source.name, source.kind, {}).catch(() => null);
    void loop(EXPORTS);
    void loop(CRAWL_SOURCES);
}
