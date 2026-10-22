import Debug from "@yiffy/debug";

import { dataKey } from "../config.ts";
import sql from "../db.ts";
import redis from "../redis.ts";

const INTERVAL_MS = 5 * 60_000;

export interface DataCounts {
    computed_at: string;
    resources: Record<string, { max_id: number; stored: number }>;
}

async function compute(): Promise<void> {
    const rows = await sql<Array<{ count: number | string; max: number | string; resource: string }>>`SELECT resource, count(*) AS count, max(id) AS max FROM snapshots GROUP BY resource`;
    const counts: DataCounts = {
        computed_at: new Date().toISOString(),
        resources: Object.fromEntries(rows.map(row => [row.resource, { stored: Number(row.count), max_id: Number(row.max) }])),
    };
    await redis.set(dataKey, JSON.stringify(counts));
}

export function startDataCounts(): void {
    const run = (): void => void compute().catch((err: unknown) => { Debug("ingester", `counting snapshots failed: ${String(err)}`); });
    setTimeout(run, 10_000);
    setInterval(run, INTERVAL_MS);
}
