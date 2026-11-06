import { SQL } from "bun";

import { databaseURL } from "./config.ts";

const sql = new SQL(databaseURL, { max: 4 });
export default sql;

export async function migrate(): Promise<void> {
    // change_seq for posts, updated_at for everything else
    await sql`
        CREATE TABLE IF NOT EXISTS snapshots (
            resource text NOT NULL,
            id bigint NOT NULL,
            version bigint NOT NULL,
            data jsonb NOT NULL,
            PRIMARY KEY (resource, id)
        )
    `;
    await sql`
        CREATE TABLE IF NOT EXISTS backfill (
            source text PRIMARY KEY,
            kind text NOT NULL,
            status text NOT NULL DEFAULT 'pending',
            cursor bigint,
            ceiling bigint,
            stored bigint NOT NULL DEFAULT 0,
            detail text,
            error text,
            started_at timestamptz,
            finished_at timestamptz,
            updated_at timestamptz NOT NULL DEFAULT now()
        )
    `;
    await sql`ALTER TABLE backfill ADD COLUMN IF NOT EXISTS lanes jsonb`;
    await sql`CREATE INDEX IF NOT EXISTS snapshots_post_replacement_post ON snapshots (((data->>'post_id')::bigint)) WHERE resource = 'post_replacement'`;
}

export interface Snapshot { data: unknown; id: number; version: number }

export async function getSnapshots(resource: string, ids: Array<number>): Promise<Map<number, Record<string, unknown>>> {
    if (ids.length === 0) return new Map();
    const rows = await sql<Array<{ data: Record<string, unknown>; id: number | string }>>`SELECT id, data FROM snapshots WHERE resource = ${resource} AND id = ANY(${sql.array(ids, "INT8")})`;
    return new Map(rows.map(row => [Number(row.id), row.data]));
}

export async function putSnapshots(resource: string, snapshots: Array<Snapshot>): Promise<void> {
    if (snapshots.length === 0) return;
    // postgres errors if the same row is in one insert twice
    const newest = new Map<number, Snapshot>();
    for (const snap of snapshots) if ((newest.get(snap.id)?.version ?? -1) <= snap.version) newest.set(snap.id, snap);
    // locked in id order so this can't deadlock with the backfill
    const rows = [...newest.values()].sort((a, b) => a.id - b.id);
    await sql`
        INSERT INTO snapshots (resource, id, version, data)
        SELECT ${resource}, t.id, t.version, t.data::jsonb
        FROM unnest(${sql.array(rows.map(r => r.id), "INT8")}, ${sql.array(rows.map(r => r.version), "INT8")}, ${sql.array(rows.map(r => JSON.stringify(r.data)), "TEXT")}) AS t(id, version, data)
        ORDER BY t.id
        ON CONFLICT (resource, id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data
        WHERE snapshots.version <= EXCLUDED.version
    `;
}

export async function getReplacementSnapshots(postId: number): Promise<Map<number, Record<string, unknown>>> {
    const rows = await sql<Array<{ data: Record<string, unknown>; id: number | string }>>`SELECT id, data FROM snapshots WHERE resource = 'post_replacement' AND (data->>'post_id')::bigint = ${postId}`;
    return new Map(rows.map(row => [Number(row.id), row.data]));
}

export async function deleteSnapshots(resource: string, ids: Array<number>): Promise<void> {
    if (ids.length === 0) return;
    await sql`DELETE FROM snapshots WHERE resource = ${resource} AND id = ANY(${sql.array(ids, "INT8")})`;
}

export async function retryDeadlocks<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const deadlock = (err as { code?: string; errno?: string }).errno === "40P01" || (err as { code?: string }).code === "40P01" || String(err).includes("deadlock detected");
            if (!deadlock || attempt >= attempts) throw err;
            await Bun.sleep(attempt * 1000);
        }
    }
}

export const versionOf = (item: { updated_at?: string | null }): number => {
    const time = Date.parse(item.updated_at ?? "");
    return Number.isNaN(time) ? 0 : time;
};
