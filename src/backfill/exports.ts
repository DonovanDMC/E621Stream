import Debug from "@yiffy/debug";
import E621ExportDownloader from "e621-export-downloader";

import { databaseURL, e621UserAgent } from "../config.ts";
import sql from "../db.ts";

import { setState } from "./state.ts";

type ExportName = "bulk_update_requests" | "pools" | "post_replacements" | "posts" | "tag_aliases" | "tag_implications" | "tags";

const downloader = new E621ExportDownloader();
const POST_BATCH = 250_000;
const CATEGORIES = ["general", "artist", "contributor", "copyright", "character", "species", "invalid", "meta", "lore"];

type Written = Array<never> & { count: number };

const ident = (name: string): string => `"${name.replaceAll("\"", "\"\"")}"`;

interface Field { columns: Array<string>; field: string; sql: string }

interface Staged { columns: Set<string>; table: string }

// e621-export-downloader's download buffers everything in memory when it can't write it out fast enough, which
// got the ingester oom killed on the posts export
async function streamImport(url: string, table: string): Promise<void> {
    const proc = Bun.spawn(["sh", "-c", "set -o pipefail; curl -sSfL -A \"$AGENT\" \"$URL\" | gunzip | psql \"$DATABASE\" --no-psqlrc -q -v ON_ERROR_STOP=1 -c \"\\copy $TABLE FROM STDIN WITH (FORMAT csv, HEADER true)\""], {
        env: { ...process.env, AGENT: e621UserAgent, URL: url, DATABASE: databaseURL, TABLE: table },
        stdout: "ignore",
        stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`importing ${url} failed (${code}): ${stderr.trim()}`);
}

// everything as text so null and "" stay as they are
async function stage(source: string, name: ExportName, required: Array<string>): Promise<Staged> {
    const table = `bf_${name}`;
    const exp = await downloader.get(name);
    Debug("backfill", `downloading the ${name} export from ${exp.data.updated_at}`);
    await setState(source, "export", { detail: `downloading and importing the ${name} export from ${exp.data.updated_at} (${Math.round(exp.data.file_size / 1e6)}MB compressed)` });
    const columns = await exp.getColumns();
    const missing = required.filter(column => !columns.includes(column));
    if (missing.length !== 0) throw new Error(`the ${name} export no longer has ${missing.join(", ")}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
    if (name === "posts") await sql.unsafe("DROP TABLE IF EXISTS bf_children, bf_post_pools");
    await sql.unsafe(`CREATE UNLOGGED TABLE ${table} (${columns.map(column => `${ident(column)} text`).join(", ")})`);
    await streamImport(exp.data.url, table);
    const [{ count }] = await sql.unsafe<[{ count: number }]>(`SELECT count(*)::int AS count FROM ${table}`);
    Debug("backfill", `staged ${count} ${name}`);
    return { table, columns: new Set(columns) };
}

function build(name: string, fields: Array<Field>, has: (column: string) => boolean): string {
    const usable = fields.filter(field => field.columns.every(column => has(column)));
    const skipped = fields.filter(field => !usable.includes(field)).map(field => field.field);
    if (skipped.length !== 0) Debug("backfill", `${name}: the export doesn't have what's needed for ${skipped.join(", ")}, those are left to the next update`);
    return `jsonb_build_object(${usable.map(field => `'${field.field}', ${field.sql}`).join(", ")})`;
}

const text = (column: string, alias = ""): Field => ({ field: column, columns: [column], sql: `${alias}${ident(column)}` });
const int = (column: string, alias = ""): Field => ({ field: column, columns: [column], sql: `nullif(${alias}${ident(column)}, '')::bigint` });

// export timestamps are utc without a timezone
const version = (has: (column: string) => boolean): string => has("updated_at") ? "coalesce((extract(epoch FROM (nullif(updated_at, '')::timestamp AT TIME ZONE 'UTC')) * 1000)::bigint, 0)" : "0";
const upsert = "ON CONFLICT (resource, id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data WHERE snapshots.version <= EXCLUDED.version";

const tagRequest = [text("status"), text("antecedent_name"), text("consequent_name"), text("reason"), int("approver_id"), int("forum_topic_id")];
const REQUESTS = {
    tag_aliases: { resource: "tag_alias", fields: tagRequest },
    tag_implications: { resource: "tag_implication", fields: tagRequest },
    bulk_update_requests: { resource: "bulk_update_request", fields: [text("status"), text("title"), text("script"), int("approver_id"), int("forum_topic_id")] },
    post_replacements: { resource: "post_replacement", fields: [text("status"), int("approver_id"), text("reason"), int("post_id")] },
} satisfies Record<string, { fields: Array<Field>; resource: string }>;

export async function importRequests(name: keyof typeof REQUESTS): Promise<void> {
    const { fields, resource } = REQUESTS[name];
    const { columns, table } = await stage(name, name, ["id"]);
    const has = (column: string): boolean => columns.has(column);
    const result = await sql.unsafe<Written>(`
        INSERT INTO snapshots (resource, id, version, data)
        SELECT '${resource}', id::bigint, ${version(has)}, ${build(name, fields, has)} FROM ${table}
        ${upsert}
    `);
    Debug("backfill", `${name}: wrote ${result.count} snapshot(s)`);
    await setState(name, "export", { stored: result.count, detail: null });
    await sql.unsafe(`DROP TABLE ${table}`);
}

const flag = (name: string, column: string): string => `'${name}', b.${column} = 't'`;
const FLAGS = [["pending", "is_pending"], ["flagged", "is_flagged"], ["note_locked", "is_note_locked"], ["status_locked", "is_status_locked"], ["rating_locked", "is_rating_locked"], ["deleted", "is_deleted"]] as const;

export async function importPosts(): Promise<void> {
    const tags = await stage("posts", "tags", []);
    const pools = await stage("posts", "pools", []);
    const posts = await stage("posts", "posts", ["id", "change_seq"]);
    const has = (column: string): boolean => {
        if (column === "tags:name,category") return tags.columns.has("name") && tags.columns.has("category");
        if (column === "pools:id,post_ids") return pools.columns.has("id") && pools.columns.has("post_ids");
        return posts.columns.has(column);
    };
    const fields: Array<Field> = [
        int("approver_id", "b."),
        { field: "change_seq", columns: ["change_seq"], sql: "b.change_seq::bigint" },
        { field: "children", columns: ["parent_id"], sql: "coalesce(c.ids, '[]'::jsonb)" },
        { field: "description", columns: ["description"], sql: "coalesce(b.description, '')" },
        { field: "flags", columns: FLAGS.map(([, column]) => column), sql: `jsonb_build_object(${FLAGS.map(([name, column]) => flag(name, column)).join(", ")})` },
        { field: "has_notes", columns: ["last_noted_at"], sql: "coalesce(b.last_noted_at, '') <> ''" },
        { field: "locked_tags", columns: ["locked_tags"], sql: "to_jsonb(coalesce(string_to_array(nullif(b.locked_tags, ''), ' '), '{}'))" },
        text("md5", "b."),
        int("parent_id", "b."),
        { field: "pools", columns: ["pools:id,post_ids"], sql: "coalesce(p.ids, '[]'::jsonb)" },
        text("rating", "b."),
        { field: "sources", columns: ["source"], sql: "to_jsonb(coalesce(string_to_array(nullif(b.source, ''), E'\\n'), '{}'))" },
        { field: "tags", columns: ["tag_string", "tags:name,category"], sql: "coalesce(t.tags, '{}'::jsonb)" },
        { field: "score", columns: ["score", "up_score", "down_score"], sql: "jsonb_build_object('up', b.up_score::int, 'down', b.down_score::int, 'total', b.score::int)" },
        { field: "fav_count", columns: ["fav_count"], sql: "b.fav_count::int" },
        { field: "comment_count", columns: ["comment_count"], sql: "b.comment_count::int" },
    ];
    const data = build("posts", fields, has);

    await sql.unsafe(`ALTER TABLE ${posts.table} ALTER COLUMN id TYPE bigint USING id::bigint`);
    await sql.unsafe(`CREATE INDEX ON ${posts.table} (id)`);
    Debug("backfill", "working out children and pools");
    await setState("posts", "export", { detail: "working out each post's children and pools" });
    if (has("parent_id")) {
        await sql.unsafe(`
            CREATE UNLOGGED TABLE bf_children AS
            SELECT parent_id::bigint AS id, jsonb_agg(id ORDER BY id) AS ids FROM ${posts.table} WHERE parent_id <> '' GROUP BY 1
        `);
    } else {
        await sql.unsafe("CREATE UNLOGGED TABLE bf_children (id bigint, ids jsonb)");
    }
    await sql.unsafe("CREATE INDEX ON bf_children (id)");
    if (has("pools:id,post_ids")) {
        await sql.unsafe(`
            CREATE UNLOGGED TABLE bf_post_pools AS
            SELECT post_id AS id, jsonb_agg(pool_id ORDER BY pool_id) AS ids
            FROM (SELECT id::bigint AS pool_id, unnest(post_ids::bigint[]) AS post_id FROM ${pools.table}) p GROUP BY 1
        `);
    } else {
        await sql.unsafe("CREATE UNLOGGED TABLE bf_post_pools (id bigint, ids jsonb)");
    }
    await sql.unsafe("CREATE INDEX ON bf_post_pools (id)");
    const tagged = has("tag_string") && has("tags:name,category");
    if (tagged) await sql.unsafe(`CREATE INDEX ON ${tags.table} (name)`);

    const [{ max }] = await sql.unsafe<[{ max: number | string }]>(`SELECT coalesce(max(id), 0)::bigint AS max FROM ${posts.table}`);
    const categories = `ARRAY[${CATEGORIES.map(c => `'${c}'`).join(", ")}]`;
    const postTags = tagged
        ? `tag_rows AS (
                SELECT b.id, coalesce(t.category::int, 0) AS category, tag
                FROM batch b CROSS JOIN LATERAL unnest(string_to_array(nullif(b.tag_string, ''), ' ')) AS tag
                LEFT JOIN ${tags.table} t ON t.name = tag
            ),
            by_category AS (SELECT id, category, jsonb_agg(tag) AS tags FROM tag_rows GROUP BY id, category),
            post_tags AS (SELECT id, jsonb_object_agg((${categories})[category + 1], tags) AS tags FROM by_category GROUP BY id)`
        : "post_tags AS (SELECT NULL::bigint AS id, NULL::jsonb AS tags WHERE false)";
    let written = 0;
    for (let from = 0; from < Number(max); from += POST_BATCH) {
        const to = from + POST_BATCH;
        const result = await sql.unsafe<Written>(`
            WITH batch AS (SELECT * FROM ${posts.table} WHERE id > ${from} AND id <= ${to}),
            ${postTags}
            INSERT INTO snapshots (resource, id, version, data)
            SELECT 'post', b.id, b.change_seq::bigint, ${data}
            FROM batch b
            LEFT JOIN post_tags t ON t.id = b.id
            LEFT JOIN bf_children c ON c.id = b.id
            LEFT JOIN bf_post_pools p ON p.id = b.id
            ${upsert}
        `);
        written += result.count;
        Debug("backfill", `posts: up to id ${to}, ${written} snapshot(s) written`);
        await setState("posts", "export", { cursor: Math.min(to, Number(max)), ceiling: Number(max), stored: written, detail: "building snapshots" });
    }
    for (const table of [tags.table, pools.table, posts.table, "bf_children", "bf_post_pools"]) await sql.unsafe(`DROP TABLE ${table}`);
    await setState("posts", "export", { detail: null });
}
