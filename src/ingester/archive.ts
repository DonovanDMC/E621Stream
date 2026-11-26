import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import DB from "../db/DB.ts";
import Redis, { fieldsToObject, type StreamEntry } from "../db/Redis.ts";
import { streamKey } from "../gateway/events.ts";
import { splitID } from "../gateway/history.ts";

const ARCHIVE_MS = 1000;
const EXPIRE_MS = 5 * 60_000;
const PAGE = 1000;
const HOUR_MS = 60 * 60 * 1000;

// hours we know have a partition
const partitions: Array<number> = [];

const partitionName = (hour: number): string => `events_${new Date(hour).toISOString().slice(0, 13).replaceAll(/\D/g, "")}`;

async function ensurePartition(hour: number): Promise<void> {
    if (partitions.includes(hour)) return;
    await DB.unsafe(`CREATE TABLE IF NOT EXISTS "${partitionName(hour)}" PARTITION OF events FOR VALUES FROM (${hour}) TO (${hour + HOUR_MS})`);
    partitions.push(hour);
}

async function newestArchived(): Promise<string | null> {
    const [row] = await DB<Array<{ ms: string; seq: string }>>`SELECT ms, seq FROM events ORDER BY ms DESC, seq DESC LIMIT 1`;
    return row ? `${row.ms}-${row.seq}` : null;
}

/** Copies what's new on the stream to postgres, then trims the stream down to the live period */
export async function archive(): Promise<number> {
    let archived = await newestArchived();
    let copied = 0;
    for (;;) {
        const entries = await Redis.send("XRANGE", [streamKey, archived ? `(${archived}` : "-", "+", "COUNT", String(PAGE)]) as Array<StreamEntry>;
        if (entries.length === 0) break;
        const rows = entries.map(([id, fields]) => {
            const [ms, seq] = splitID(id);
            const item = fieldsToObject(fields);
            return { ms, seq, type: String(item.type), item };
        });
        for (const hour of [...new Set(rows.map(row => row.ms - (row.ms % HOUR_MS)))]) await ensurePartition(hour);
        await DB`
            INSERT INTO events (ms, seq, type, item)
            SELECT (row->>'ms')::BIGINT, (row->>'seq')::BIGINT, row->>'type', row->'item' FROM json_array_elements(${JSON.stringify(rows)}::TEXT::JSON) AS row
            ON CONFLICT DO NOTHING
        `;
        archived = entries.at(-1)![0];
        copied += entries.length;
        if (entries.length < PAGE) break;
    }
    if (archived) {
        // never past what's been copied, so a replay always finds everything in one or the other
        const live = Date.now() - (Config.streamLivePeriod * 60_000);
        const minID = splitID(archived)[0] < live ? archived : `${live}-0`;
        await Redis.send("XTRIM", [streamKey, "MINID", minID]);
    }
    return copied;
}

/** Drops the hours that are all older than the replay period */
export async function expire(): Promise<Array<string>> {
    if (Config.replayPeriod === 0) return [];
    const before = Date.now() - (Config.replayPeriod * HOUR_MS);
    const rows = await DB<Array<{ name: string }>>`
        SELECT child.relname AS name FROM pg_inherits
        JOIN pg_class child ON child.oid = pg_inherits.inhrelid
        WHERE pg_inherits.inhparent = 'events'::regclass
    `;
    const dropped: Array<string> = [];
    for (const { name } of rows) {
        const match = /^events_(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(name);
        if (!match) continue;
        const hour = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]));
        if (hour + HOUR_MS > before) continue;
        await DB.unsafe(`DROP TABLE "${name}"`);
        const known = partitions.indexOf(hour);
        if (known !== -1) partitions.splice(known, 1);
        dropped.push(name);
    }
    return dropped;
}

/** Copies the stream every second and drops expired hours every few minutes. The first copy is waited for */
export async function startArchive(): Promise<void> {
    const copy = async (): Promise<void> => {
        const copied = await archive().catch((err: unknown) => {
            Debug("ingester:archive", `copying failed: ${String(err)}`);
            // in case it was a partition being dropped by hand
            partitions.length = 0;
            return 0;
        });
        if (copied >= PAGE) Debug("ingester:archive", `copied ${copied} event(s)`);
        setTimeout(() => void copy(), ARCHIVE_MS);
    };
    const drop = async (): Promise<void> => {
        const dropped = await expire().catch((err: unknown) => {
            Debug("ingester:archive", `expiring failed: ${String(err)}`);
            return [];
        });
        if (dropped.length !== 0) Debug("ingester:archive", `dropped ${dropped.join(", ")}`);
    };
    await copy();
    await drop();
    setInterval(() => void drop(), EXPIRE_MS);
}
