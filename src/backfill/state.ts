import sql from "../db.ts";

// a backfill source's row in the `backfill` table

// waiting: a crawl whose feed hasn't started yet, it needs the feed's cursor as its ceiling
export type Status = "done" | "failed" | "pending" | "running" | "waiting";

// one slice of a crawl, going down from cursor (exclusive) to lower
export interface Lane { cursor: number; lower: number }

export interface BackfillState {
    // crawl: the id it started below. export: the highest post id
    ceiling: number | null;
    // crawl: ids left to go. export: how far it's gotten
    cursor: number | null;
    // what it's doing right now, for the status page
    detail: string | null;
    error: string | null;
    finished_at: Date | null;
    kind: "crawl" | "export";
    lanes: Array<Lane> | null;
    source: string;
    started_at: Date | null;
    status: Status;
    // snapshots written so far
    stored: number;
    updated_at: Date;
}

// bigints come back as strings
type Row = Omit<BackfillState, "ceiling" | "cursor" | "stored"> & { ceiling: number | string | null; cursor: number | string | null; stored: number | string };
const parse = (row: Row): BackfillState => ({
    ...row,
    ceiling: row.ceiling === null ? null : Number(row.ceiling),
    cursor: row.cursor === null ? null : Number(row.cursor),
    stored: Number(row.stored),
});

export async function getState(source: string): Promise<BackfillState | null> {
    const [row] = await sql<Array<Row>>`SELECT * FROM backfill WHERE source = ${source}`;
    return row ? parse(row) : null;
}

export async function listStates(): Promise<Array<BackfillState>> {
    return (await sql<Array<Row>>`SELECT * FROM backfill`).map(parse);
}

// creates the row if it isn't there, then updates whatever's in patch
export async function setState(source: string, kind: BackfillState["kind"], patch: Partial<Omit<BackfillState, "kind" | "source" | "updated_at">>): Promise<void> {
    await sql`INSERT INTO backfill (source, kind) VALUES (${source}, ${kind}) ON CONFLICT (source) DO NOTHING`;
    if (Object.keys(patch).length !== 0) await sql`UPDATE backfill SET ${sql(patch)}, updated_at = now() WHERE source = ${source}`;
}

// a string cast straight to jsonb gets stored as a json string
export async function setLanes(source: string, lanes: Array<Lane>, patch: { cursor: number; stored: number }): Promise<void> {
    await sql`UPDATE backfill SET lanes = ${JSON.stringify(lanes)}::text::jsonb, cursor = ${patch.cursor}, stored = ${patch.stored}, updated_at = now() WHERE source = ${source}`;
}

export async function resetState(source: string): Promise<void> {
    await sql`DELETE FROM backfill WHERE source = ${source}`;
}
