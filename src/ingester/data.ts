import Debug from "@yiffy/debug";

import Config from "../Config.ts";
import DB from "../db/DB.ts";
import Redis from "../db/Redis.ts";

const dataKey = `${Config.redisPrefix}data`;
const INTERVAL_MS = 5 * 60_000;
const FIRST_MS = 10_000;

export interface DataCounts {
    computed_at: string; // ISO timestamp
    /** bytes is the stored data, before row and index overhead */
    resources: Record<string, { bytes: number; max_id: number; stored: number }>;
}

// counting every snapshot is slow, so it's done here and read by the status page
async function compute(): Promise<void> {
    const rows = await DB<Array<{ bytes: string; count: string; max: string; resource: string }>>`SELECT resource, count(*) AS count, max(id) AS max, sum(pg_column_size(data)) AS bytes FROM snapshots GROUP BY resource`;
    const counts: DataCounts = {
        computed_at: new Date().toISOString(),
        resources: Object.fromEntries(rows.map(row => [row.resource, { stored: Number(row.count), max_id: Number(row.max), bytes: Number(row.bytes) }])),
    };
    await Redis.set(dataKey, JSON.stringify(counts));
}

export async function getDataCounts(): Promise<DataCounts | null> {
    const raw = await Redis.get(dataKey);
    return raw ? JSON.parse(raw) as DataCounts : null;
}

export function startDataCounts(): void {
    const run = (): void => void compute().catch((err: unknown) => { Debug("ingester", `counting snapshots failed: ${String(err)}`); });
    setTimeout(run, FIRST_MS);
    setInterval(run, INTERVAL_MS);
}
