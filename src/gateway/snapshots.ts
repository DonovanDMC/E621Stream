import * as Schemas from "e621-openapi/schemas";

import DB from "../db/DB.ts";
import Snapshot from "../db/models/Snapshot.ts";

import type * as Types from "e621-openapi/types";
import type { JSONSchema7 } from "json-schema";

type DeepReadonly<T> = T extends (...args: Array<never>) => unknown ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type ObjectSchema = DeepReadonly<Omit<JSONSchema7, "type" | "properties"> & { properties: Exclude<JSONSchema7["properties"], undefined>; type: "object" }>;

function schemaAndKeys<Schema extends ObjectSchema, Excluded extends keyof Schema["properties"] = never>(schema: Schema, exclude: Array<Excluded> = []): { props: Array<Exclude<keyof Schema["properties"], Excluded>>; schema: Schema } {
    const props = Object.keys(schema.properties).filter(p => !exclude.includes(p as Excluded)) as Array<Exclude<keyof Schema["properties"], Excluded>>;
    return { props, schema };
}

export interface SnapshotTypeMap {
    artist: Types.Artist;
    artist_url: Types.ArtistURL;
    artist_version: Types.ArtistVersion;
    avoid_posting: Types.AvoidPosting;
    ban: Types.Ban;
    blip: Types.Blip;
    bulk_update_request: Types.BulkUpdateRequest;
    comment: Types.Comment;
    forum_post: Types.ForumPost;
    forum_topic: Types.ForumTopic;
    help_page: Types.HelpPage;
    mod_action: Types.ModAction;
    news_update: Types.NewsUpdate;
    note: Types.Note;
    note_version: Types.NoteVersion;
    pool: Types.Pool;
    pool_version: Types.PoolVersion;
    post: Types.ExtendedPost;
    post_approval: Types.PostApproval;
    post_event: Types.PostEvent;
    post_flag: Types.PostFlag;
    post_replacement: Types.PostReplacement;
    post_set: Types.PostSet;
    post_version: Types.PostVersion;
    tag: Types.Tag;
    tag_alias: Types.TagAlias;
    tag_implication: Types.TagImplication;
    tag_type_version: Types.TagTypeVersion;
    takedown: Types.Takedown;
    upload_karma_event: Types.UploadKarmaEvent;
    upload_url_rule: Types.UploadURLRule;
    upload_whitelist: Types.UploadWhitelist;
    user: Types.User;
    user_feedback: Types.UserFeedback;
    wiki_page: Types.WikiPage;
    wiki_page_version: Types.WikiPageVersion;
}

export type SnapshotData<K extends SnapshotResourceType = SnapshotResourceType> = K extends SnapshotResourceType ? Pick<SnapshotTypeMap[K], Extract<(typeof SnapshotDataMap)[K]["props"][number], keyof SnapshotTypeMap[K]>> : never;

const SnapshotDataMap = {
    artist: schemaAndKeys(Schemas.ArtistSchema),
    artist_url: schemaAndKeys(Schemas.ArtistURLSchema),
    artist_version: schemaAndKeys(Schemas.ArtistVersionSchema),
    avoid_posting: schemaAndKeys(Schemas.AvoidPostingSchema),
    ban: schemaAndKeys(Schemas.BanSchema),
    blip: schemaAndKeys(Schemas.BlipSchema),
    bulk_update_request: schemaAndKeys(Schemas.BulkUpdateRequestSchema),
    comment: schemaAndKeys(Schemas.CommentSchema, ["vote"]), // vote is the authenticated user
    forum_post: schemaAndKeys(Schemas.ForumPostSchema),
    forum_topic: schemaAndKeys(Schemas.ForumTopicSchema),
    help_page: schemaAndKeys(Schemas.HelpPageSchema),
    mod_action: schemaAndKeys(Schemas.ModActionSchema),
    news_update: schemaAndKeys(Schemas.NewsUpdateSchema),
    note: schemaAndKeys(Schemas.NoteSchema),
    note_version: schemaAndKeys(Schemas.NoteVersionSchema),
    pool: schemaAndKeys(Schemas.PoolSchema),
    pool_version: schemaAndKeys(Schemas.PoolVersionSchema),
    // the extended schema is an allOf, so it has no properties of its own
    post: { ...schemaAndKeys(Schemas.PostSchema), props: [...schemaAndKeys(Schemas.PostSchema).props, "tags" as const] },
    post_approval: schemaAndKeys(Schemas.PostApprovalSchema),
    post_event: schemaAndKeys(Schemas.PostEventSchema),
    post_flag: schemaAndKeys(Schemas.PostFlagSchema),
    post_replacement: schemaAndKeys(Schemas.PostReplacementSchema),
    post_set: schemaAndKeys(Schemas.PostSetSchema),
    post_version: schemaAndKeys(Schemas.PostVersionSchema),
    tag: schemaAndKeys(Schemas.TagSchema),
    tag_alias: schemaAndKeys(Schemas.TagAliasSchema),
    tag_implication: schemaAndKeys(Schemas.TagImplicationSchema),
    tag_type_version: schemaAndKeys(Schemas.TagTypeVersionSchema),
    takedown: schemaAndKeys(Schemas.TakedownSchema),
    upload_karma_event: schemaAndKeys(Schemas.UploadKarmaEventSchema),
    upload_url_rule: schemaAndKeys(Schemas.UploadURLRuleSchema),
    upload_whitelist: schemaAndKeys(Schemas.UploadWhitelistSchema),
    user: schemaAndKeys(Schemas.UserSchema),
    user_feedback: schemaAndKeys(Schemas.UserFeedbackSchema),
    wiki_page: schemaAndKeys(Schemas.WikiPageSchema),
    wiki_page_version: schemaAndKeys(Schemas.WikiPageVersionSchema),
} satisfies Record<string, { props: Array<string>; schema: ObjectSchema }>;
export type SnapshotResourceType = keyof typeof SnapshotDataMap;

function pickData<Type extends SnapshotResourceType>(type: Type, data: SnapshotTypeMap[Type]): Record<string, unknown> {
    const { props } = SnapshotDataMap[type];
    return Object.fromEntries(Object.entries(data).filter(([key]) => props.includes(key as never)));
}

/** Posts use change_seq, everything else its timestamps */
export function versionOf<Type extends SnapshotResourceType>(type: Type, data: SnapshotTypeMap[Type]): number | undefined {
    if (type === "post") return (data as SnapshotTypeMap["post"]).change_seq;
    if ("updated_at" in data && data.updated_at) return new Date(data.updated_at).getTime();
    if ("created_at" in data && data.created_at) return new Date(data.created_at).getTime();
    console.warn(`Unsure how to version ${type}: ${JSON.stringify(data)}`);
    return undefined;
}

export async function saveSnapshot<Type extends SnapshotResourceType>(type: Type, data: SnapshotTypeMap[Type]): Promise<Snapshot> {
    const saveData = pickData(type, data);
    const version = versionOf(type, data);

    let snapshot = await Snapshot.find(type, data.id);
    if (snapshot) {
        await snapshot.update({ data: saveData, version });
    } else {
        snapshot = await Snapshot.create({
            resource: type,
            id: data.id,
            version,
            data: saveData,
        });
    }

    return snapshot;
}

export async function removeSnapshot(type: SnapshotResourceType, id: number): Promise<Snapshot | null> {
    const snapshot = await Snapshot.find(type, id);
    if (!snapshot) return null;

    const deleted = await snapshot.destroy();
    if (!deleted) {
        console.warn(`Failed to delete snapshot ${type}:${id}`);
    }

    return snapshot;
}

/** Many at once, older versions don't replace newer ones that are already stored */
export async function saveSnapshots<Type extends SnapshotResourceType>(type: Type, records: Array<SnapshotTypeMap[Type]>): Promise<void> {
    if (records.length === 0) return;
    // postgres errors if the same row is in one insert twice
    const newest = new Map<number, { data: Record<string, unknown>; id: number; version: number }>();
    for (const record of records) {
        const version = versionOf(type, record) ?? 0;
        if ((newest.get(record.id)?.version ?? -1) <= version) newest.set(record.id, { id: record.id, version, data: pickData(type, record) });
    }
    // locked in id order so this can't deadlock with the backfill
    const rows = [...newest.values()].sort((a, b) => a.id - b.id);
    await DB`
        INSERT INTO snapshots (resource, id, version, data)
        SELECT ${type}, t.id, t.version, t.data::jsonb
        FROM unnest(${DB.array(rows.map(row => row.id), "INT8")}, ${DB.array(rows.map(row => row.version), "INT8")}, ${DB.array(rows.map(row => JSON.stringify(row.data)), "TEXT")}) AS t(id, version, data)
        ORDER BY t.id
        ON CONFLICT (resource, id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data
        WHERE snapshots.version <= EXCLUDED.version
    `;
}

/** Keyed by id, ones that aren't stored are left out */
export async function getSnapshots<Type extends SnapshotResourceType>(type: Type, ids: Array<number>): Promise<Map<number, { data: SnapshotTypeMap[Type]; version: number }>> {
    const rows = await Snapshot.whereIn("id", ids, { resource: type });
    return new Map(rows.map(row => [row.id, { data: row.data as SnapshotTypeMap[Type], version: row.version }]));
}

export async function removeSnapshots(type: SnapshotResourceType, ids: Array<number>): Promise<void> {
    if (ids.length === 0) return;
    await DB`DELETE FROM snapshots WHERE resource = ${type} AND id IN ${DB(ids)}`;
}

/** The stored record with changes applied and saved back, null when it isn't stored */
export async function updateSnapshot<Type extends SnapshotResourceType>(type: Type, id: number, changes: Partial<SnapshotTypeMap[Type]>): Promise<SnapshotTypeMap[Type] | null> {
    const snapshot = await Snapshot.find(type, id);
    if (!snapshot) return null;
    const data = { ...snapshot.data, ...changes } as SnapshotTypeMap[Type];
    // something newer is already stored, like from the backfill
    const at = "updated_at" in changes && typeof changes.updated_at === "string" ? Date.parse(changes.updated_at) : Number.NaN;
    if (!Number.isNaN(at) && snapshot.version > at) return snapshot.data as SnapshotTypeMap[Type];
    await saveSnapshot(type, data);
    return data;
}

/** Every id stored for a resource, for lists that are fetched whole */
export async function getSnapshotIDs(type: SnapshotResourceType): Promise<Array<number>> {
    const rows = await DB<Array<{ id: string }>>`SELECT id FROM snapshots WHERE resource = ${type}`;
    return rows.map(row => Number(row.id));
}

/** Tag mod actions only log the name */
export async function getTagSnapshotByName(name: string): Promise<SnapshotTypeMap["tag"] | null> {
    const snapshot = await Snapshot.findTagByName(name);
    return snapshot ? snapshot.data as SnapshotTypeMap["tag"] : null;
}

// a mod action this long before a change still counts as what made it
const MOD_ACTION_WINDOW_MS = 10 * 60_000;

/** Who made a change, from the mod action logged for it. Only staff changes are logged */
export async function modActionUpdater(actions: Array<string>, field: string, value: string | number, at: string): Promise<number | null> {
    const action = await Snapshot.latestModAction(actions, field, value, new Date(Date.parse(at) - MOD_ACTION_WINDOW_MS));
    return action ? (action.data as SnapshotTypeMap["mod_action"]).creator_id : null;
}

/** An artist's urls, artists from searches don't have them */
export async function getArtistURLSnapshots(artistID: number): Promise<Array<SnapshotTypeMap["artist_url"]>> {
    return (await Snapshot.artistURLsFor(artistID)).map(snapshot => snapshot.data as SnapshotTypeMap["artist_url"]);
}

/** Help page mod actions only log the name */
export async function getHelpPageSnapshotByName(name: string): Promise<SnapshotTypeMap["help_page"] | null> {
    const snapshot = await Snapshot.findHelpPageByName(name);
    return snapshot ? snapshot.data as SnapshotTypeMap["help_page"] : null;
}

/** Unbans only log the user */
export async function getBanSnapshotByUser(userID: number): Promise<SnapshotTypeMap["ban"] | null> {
    const snapshot = await Snapshot.findBanByUser(userID);
    return snapshot ? snapshot.data as SnapshotTypeMap["ban"] : null;
}

/** Replacement post events only log the post */
export async function getReplacementSnapshots(postID: number): Promise<Array<Snapshot>> {
    return Snapshot.replacementsForPost(postID);
}

export async function getSnapshot<Type extends SnapshotResourceType>(type: Type, id: number): Promise<SnapshotTypeMap[Type] | null> {
    const snapshot = await Snapshot.find(type, id);
    return snapshot ? snapshot.data as SnapshotTypeMap[Type] : null;
}
