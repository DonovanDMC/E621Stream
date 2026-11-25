import DB from "../DB.ts";

import Model from "./Model.ts";

export interface PostVersionIndexAttributes {
    id: number;
    post_id: number;
    updated_at: Date;
    updater_id: number;
    version: number;
}

type Version = Pick<PostVersionIndexAttributes, "id" | "post_id" | "updater_id" | "version"> & { updated_at: string };

/** Which post version a post's version number is, and who made it. the rest of the version isn't kept */
export default class PostVersionIndex extends Model<PostVersionIndexAttributes> {
    static override readonly columns = ["post_id", "version", "id", "updater_id", "updated_at"];
    static override readonly numbers = ["post_id", "id", "updater_id"];
    static override readonly primaryKey = ["post_id", "version"];
    static override readonly table = "post_version_index";

    declare id: number;
    declare post_id: number;
    declare updated_at: Date;
    declare updater_id: number;
    declare version: number;

    /** The version made around a time, a post's updated_at is when its newest version was made */
    static async madeAt(postID: number, at: string, slackMS: number): Promise<PostVersionIndex | null> {
        const time = Date.parse(at);
        const [version] = await PostVersionIndex.where({ post_id: postID }, { order: { version: "DESC" }, limit: 1 });
        return version && Math.abs(version.updated_at.getTime() - time) <= slackMS ? version : null;
    }

    // a version never changes, so ones already stored are left
    static async remember(versions: Array<Version>): Promise<void> {
        if (versions.length === 0) return;
        await DB`
            INSERT INTO ${DB(PostVersionIndex.table)} (post_id, version, id, updater_id, updated_at)
            SELECT * FROM unnest(
                ${DB.array(versions.map(v => v.post_id), "INT8")}, ${DB.array(versions.map(v => v.version), "INT4")}, ${DB.array(versions.map(v => v.id), "INT8")},
                ${DB.array(versions.map(v => v.updater_id), "INT8")}, ${DB.array(versions.map(v => v.updated_at), "TIMESTAMPTZ")}
            )
            ON CONFLICT DO NOTHING
        `;
    }
}
