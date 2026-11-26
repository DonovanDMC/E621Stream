import DB from "../db/DB.ts";
import Redis, { parseEntry, type StreamEntry } from "../db/Redis.ts";

import { streamKey, type StreamItem } from "./events.ts";

// events and notices are kept in postgres for replaying, the redis stream only has the last few minutes.
// the ingester copies the stream over, and never trims what it hasn't copied, so the two always meet

export const splitID = (id: string): [ms: number, seq: number] => {
    const [ms = 0, seq = 0] = id.split("-").map(Number);
    return [ms, seq];
};

interface Row { item: string; ms: string; seq: string }
const toItem = (row: Row): StreamItem => ({ ...JSON.parse(row.item) as object, id: `${row.ms}-${row.seq}` }) as StreamItem;

/** Everything after a cursor in order, in batches. The history first, then what's on the stream */
export async function* itemsAfter(cursor: string, batch: number): AsyncGenerator<Array<StreamItem>> {
    let from = cursor;
    for (;;) {
        const [ms, seq] = splitID(from);
        // the ms on its own lets postgres skip hours before it
        const rows = await DB<Array<Row>>`
            SELECT ms, seq, item::text AS item FROM events
            WHERE ms >= ${ms} AND (ms, seq) > (${ms}, ${seq})
            ORDER BY ms, seq LIMIT ${batch}
        `;
        if (rows.length !== 0) {
            const items = rows.map(toItem);
            from = items.at(-1)!.id;
            yield items;
        }
        if (rows.length < batch) break;
    }
    for (;;) {
        const entries = await Redis.send("XRANGE", [streamKey, `(${from}`, "+", "COUNT", String(batch)]) as Array<StreamEntry>;
        if (entries.length === 0) return;
        from = entries.at(-1)![0];
        const items = entries.map(parseEntry).filter(item => item !== null);
        if (items.length !== 0) yield items;
        if (entries.length < batch) return;
    }
}

/** The id of the oldest thing kept */
export async function oldestID(): Promise<string | null> {
    const [row] = await DB<Array<{ ms: string; seq: string }>>`SELECT ms, seq FROM events ORDER BY ms, seq LIMIT 1`;
    if (row) return `${row.ms}-${row.seq}`;
    const [entry] = await Redis.send("XRANGE", [streamKey, "-", "+", "COUNT", "1"]) as Array<StreamEntry>;
    return entry?.[0] ?? null;
}

/** How many events and notices are in the history, what's only on the stream so far is a second's worth at most */
export async function storedCount(): Promise<number> {
    const [row] = await DB<Array<{ count: string }>>`SELECT count(*) AS count FROM events`;
    return Number(row?.count ?? 0);
}
