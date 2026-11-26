import DB from "../db/DB.ts";
import Redis from "../db/Redis.ts";
import { streamKey } from "../gateway/events.ts";
import { getDataCounts, type DataCounts } from "../ingester/data.ts";

export interface TableStats {
    indexes: number;
    name: string;
    /** An estimate, from postgres' statistics */
    rows: number;
    table: number;
    toast: number;
    total: number;
}

export interface IndexStats {
    name: string;
    /** How many times it's been used since postgres' statistics were last reset */
    scans: number;
    size: number;
    table: string;
}

export interface DatabaseStats {
    database: number;
    indexes: Array<IndexStats>;
    redis: { keys: number; peak: number; stream: number; used: number };
    snapshots: DataCounts | null;
    tables: Array<TableStats>;
}

const field = (info: string, name: string): number => Number(new RegExp(`^${name}:(\\d+)`, "m").exec(info)?.[1] ?? 0);

// sizes are cheap to get, the per resource numbers come from the ingester's counts so the table isn't scanned here
export async function getDatabaseStats(): Promise<DatabaseStats> {
    const [[database], tables, indexes, snapshots, info, keys, stream] = await Promise.all([
        DB<Array<{ size: string }>>`SELECT pg_database_size(current_database()) AS size`,
        DB<Array<{ indexes: string; name: string; rows: string; table: string; total: string }>>`
            SELECT name, SUM(rows) AS rows, SUM(total) AS total, SUM("table") AS table, SUM(indexes) AS indexes FROM (
                -- the events table's hours are added up as one
                SELECT regexp_replace(relname, '^events_\\d{10}$', 'events') AS name, n_live_tup AS rows, pg_total_relation_size(relid) AS total, pg_relation_size(relid) AS "table", pg_indexes_size(relid) AS indexes
                FROM pg_stat_user_tables
            ) AS stats GROUP BY name ORDER BY SUM(total) DESC
        `,
        DB<Array<{ name: string; scans: string; size: string; table: string }>>`
            SELECT name, "table", SUM(size) AS size, SUM(scans) AS scans FROM (
                SELECT regexp_replace(indexrelname, '^events_\\d{10}_pkey$', 'events_pkey') AS name, regexp_replace(relname, '^events_\\d{10}$', 'events') AS "table",
                    pg_relation_size(indexrelid) AS size, idx_scan AS scans
                FROM pg_stat_user_indexes
            ) AS stats GROUP BY name, "table" ORDER BY SUM(size) DESC
        `,
        getDataCounts(),
        Redis.send("INFO", ["memory"]) as Promise<string>,
        Redis.send("DBSIZE", []) as Promise<number>,
        Redis.send("XLEN", [streamKey]) as Promise<number>,
    ]);
    return {
        database: Number(database?.size ?? 0),
        tables: tables.map(row => ({
            name: row.name,
            rows: Number(row.rows),
            total: Number(row.total),
            table: Number(row.table),
            indexes: Number(row.indexes),
            // what's left is oversized values, stored apart from the rows
            toast: Number(row.total) - Number(row.table) - Number(row.indexes),
        })),
        indexes: indexes.map(row => ({ name: row.name, table: row.table, size: Number(row.size), scans: Number(row.scans) })),
        snapshots,
        redis: { used: field(info, "used_memory"), peak: field(info, "used_memory_peak"), keys, stream },
    };
}
