import DB from "../DB.ts";

import Model from "./Model.ts";

import type { SnapshotData } from "../../gateway/snapshots.ts";

export interface SnapshotAttributes {
    data: Record<string, unknown>;
    id: number;
    resource: string;
    version: number;
}

export default class Snapshot extends Model<SnapshotAttributes> {
    static override readonly columns = ["resource", "id", "version", "data"];
    static override readonly numbers = ["id", "version"];
    static override readonly primaryKey = ["resource", "id"];
    static override readonly table = "snapshots";

    declare data: SnapshotData;
    declare id: number;
    declare resource: string;
    declare version: number;

    // uses the snapshots_artist_url_artist index
    static async artistURLsFor(artistID: number): Promise<Array<Snapshot>> {
        const rows = await DB<Array<{ id: string }>>`SELECT id FROM snapshots WHERE resource = 'artist_url' AND (data->>'artist_id')::bigint = ${artistID}`;
        return this.whereIn("id", rows.map(row => Number(row.id)), { resource: "artist_url" }, { order: { id: "ASC" } });
    }

    // uses the snapshots_ban_user index, the newest is the one that's active
    static async findBanByUser(userID: number): Promise<Snapshot | null> {
        const [row] = await DB<Array<{ id: string }>>`SELECT id FROM snapshots WHERE resource = 'ban' AND (data->>'user_id')::bigint = ${userID} ORDER BY id DESC LIMIT 1`;
        return row ? this.find("ban", Number(row.id)) : null;
    }

    // help pages are few, so these don't need an index
    static async findHelpPageByName(name: string): Promise<Snapshot | null> {
        const [row] = await DB<Array<{ id: string }>>`SELECT id FROM snapshots WHERE resource = 'help_page' AND data->>'name' = ${name} LIMIT 1`;
        return row ? this.find("help_page", Number(row.id)) : null;
    }

    // uses the snapshots_tag_name index
    static async findTagByName(name: string): Promise<Snapshot | null> {
        const [row] = await DB<Array<{ id: string }>>`SELECT id FROM snapshots WHERE resource = 'tag' AND data->>'name' = ${name} LIMIT 1`;
        return row ? this.find("tag", Number(row.id)) : null;
    }

    static async forRequest(resource: string, ids: Array<number>): Promise<Record<number, Snapshot | null>> {
        const rows = await this.whereIn("id", ids, { resource });
        return Object.fromEntries(ids.map(id => ([id, rows.find(r => r.id === id) ?? null])));
    }

    // uses the snapshots_mod_action index
    static async latestModAction(actions: Array<string>, field: string, value: string | number, since: Date): Promise<Snapshot | null> {
        const [row] = await DB<Array<{ id: string }>>`
            SELECT id FROM snapshots
            WHERE resource = 'mod_action' AND data->>'action' IN ${DB(actions)} AND data->'values'->>${field} = ${String(value)} AND (data->>'created_at')::timestamptz >= ${since}
            ORDER BY id DESC LIMIT 1
        `;
        return row ? this.find("mod_action", Number(row.id)) : null;
    }

    // uses the snapshots_post_replacement_post index
    static async replacementsForPost(postID: number): Promise<Array<Snapshot>> {
        const rows = await DB<Array<{ id: string }>>`SELECT id FROM snapshots WHERE resource = 'post_replacement' AND (data->>'post_id')::bigint = ${postID}`;
        return this.whereIn("id", rows.map(row => Number(row.id)), { resource: "post_replacement" });
    }
}
