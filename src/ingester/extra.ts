import Config from "../Config.ts";
import PostVersionIndex from "../db/models/PostVersionIndex.ts";
import Redis from "../db/Redis.ts";
import { getArtistURLSnapshots, getBanSnapshotByUser, getHelpPageSnapshotByName, getSnapshot, saveSnapshot, getTagSnapshotByName, removeSnapshot, updateSnapshot, type SnapshotResourceType, type SnapshotTypeMap } from "../gateway/snapshots.ts";
import { e621, request } from "../util/e621.ts";

import type { EventContext, EventType, EventTypeDataMap } from "../gateway/events.ts";
import type * as E621 from "e621-openapi/types";

/** An event made from a feed's item, its data has to match the event's */
export type Extra = { [K in EventType]: { context?: EventContext; data: EventTypeDataMap[K]; type: K } }[EventType];

// records are rebuilt from our snapshots instead of asking e621, so nothing is sent for ones we haven't stored
const one = <K extends EventType>(type: K, data: EventTypeDataMap[K] | null, context?: EventContext): Array<Extra> => data ? [{ type, data, ...context ? { context } : {} } as Extra] : [];

// a record's first version is made along with it, anything later is an update
const FIRST_VERSION_SLACK_MS = 1000;
const madeTogether = (record: { created_at: string }, version: string): boolean => Math.abs(Date.parse(record.created_at) - Date.parse(version)) <= FIRST_VERSION_SLACK_MS;

export async function noteVersionExtra(item: E621.NoteVersion): Promise<Array<Extra>> {
    const { body, height, is_active, post_id, updated_at, version, width, x, y } = item;
    const note = await updateSnapshot("note", item.note_id, { body, height, is_active, post_id, updated_at, version, width, x, y });
    return item.version > 1 ? one("note.update", note, { updater_id: item.updater_id }) : [];
}

export async function poolVersionExtra(item: E621.PoolVersion): Promise<Array<Extra>> {
    const { category, description, is_active, name, post_ids, updated_at } = item;
    const pool = await updateSnapshot("pool", item.pool_id, { category, description, is_active, name, post_count: post_ids.length, post_ids, updated_at });
    const updater_id = item.updater_id;
    return [
        ...item.version > 1 ? one("pool.update", pool, { updater_id }) : [],
        ...item.added_post_ids.length !== 0 ? one("pool.add_posts", pool, { updater_id, post_ids: item.added_post_ids }) : [],
        ...item.removed_post_ids.length !== 0 ? one("pool.remove_posts", pool, { updater_id, post_ids: item.removed_post_ids }) : [],
    ];
}

export async function wikiPageVersionExtra(item: E621.WikiPageVersion): Promise<Array<Extra>> {
    const { body, is_deleted, is_locked, other_names, parent, title, updated_at, updater_id } = item;
    const page = await updateSnapshot("wiki_page", item.wiki_page_id, { body, is_deleted, is_locked, other_names, parent, title, updated_at, updater_id });
    return page && !madeTogether(page, item.created_at) ? one("wiki_page.update", page) : [];
}

const creatorsKey = (artistID: number): string => `${Config.redisPrefix}artist_urls:creators:${artistID}`;
// new urls are sent by the artist_urls feed, usually after the version that added them
const CREATORS_TTL_SECONDS = 24 * 60 * 60;

// a version lists every url the artist has, inactive ones start with a -
async function artistURLChanges(item: E621.ArtistVersion, context: EventContext): Promise<Array<Extra>> {
    const listed = new Map(item.urls.map(url => url.startsWith("-") ? [url.slice(1), false] : [url, true]));
    const extras: Array<Extra> = [];
    for (const url of await getArtistURLSnapshots(item.artist_id)) {
        const active = listed.get(url.url);
        listed.delete(url.url);
        if (active === undefined) {
            await removeSnapshot("artist_url", url.id);
            extras.push(...one("artist_url.destroy", { id: url.id, artist_id: url.artist_id }, { ...context, ...previous(url) }));
        } else if (active !== url.is_active) {
            extras.push(...one("artist_url.update", await updateSnapshot("artist_url", url.id, { is_active: active, updated_at: item.updated_at }), context));
        }
    }
    // what's left is new, remembered so the create can say who added it
    if (listed.size !== 0) {
        await Redis.hset(creatorsKey(item.artist_id), Object.fromEntries([...listed.keys()].map(url => [url, String(item.updater_id)])));
        await Redis.expire(creatorsKey(item.artist_id), CREATORS_TTL_SECONDS);
    }
    return extras;
}

export async function artistVersionExtra(item: E621.ArtistVersion): Promise<Array<Extra>> {
    const context = { updater_id: item.updater_id };
    const urls = await artistURLChanges(item, context);
    const { is_active, name, other_names, updated_at } = item;
    // versions only list the urls as text, so they're rebuilt from the url records we have
    const artist = await updateSnapshot("artist", item.artist_id, { is_active, name, other_names, updated_at, urls: await getArtistURLSnapshots(item.artist_id) });
    return [...urls, ...artist && !madeTogether(artist, item.created_at) ? one("artist.update", artist, context) : []];
}

/** New urls come after the version that added them, so the artist's list is rebuilt when they're stored */
export async function refreshArtistURLs(item: E621.ArtistURL): Promise<void> {
    await updateSnapshot("artist", item.artist_id, { urls: await getArtistURLSnapshots(item.artist_id) });
}

/**
 * Who added a url, from the artist version that did.
 * Only known when the versions feed saw the version before the urls feed saw the url, it usually does since versions are polled more often.
 * When it didn't, the create goes out without it, and there's no sending it again
 */
export async function artistURLContext(item: E621.ArtistURL): Promise<EventContext> {
    const creator = await Redis.hget(creatorsKey(item.artist_id), item.url);
    return creator === null ? {} : { updater_id: Number(creator) };
}

export async function tagTypeVersionExtra(item: E621.TagTypeVersion): Promise<Array<Extra>> {
    return one("tag.update", await updateSnapshot("tag", item.tag_id, { category: item.new_type, is_locked: item.is_locked, updated_at: item.updated_at }), { updater_id: item.creator_id });
}

// dnp versions have no created_at, the first one's updated_at is when it was made
export async function avoidPostingVersionExtra(item: E621.AvoidPostingVersion): Promise<Array<Extra>> {
    const { details, is_active, staff_notes, updated_at, updater_id } = item;
    const entry = await updateSnapshot("avoid_posting", item.avoid_posting_id, { details, is_active, staff_notes, updated_at, updater_id });
    return entry && !madeTogether(entry, item.updated_at) ? one("avoid_posting.update", entry) : [];
}

/** What we had before a change, as context. nothing when we didn't have it */
export const previous = (data: object | null | undefined): EventContext | undefined => data ? { previous: data as Record<string, unknown> } : undefined;

type Values = Record<string, unknown>;
type Handler = (values: Values, at: string) => Promise<Array<Extra>>;
const idOf = (values: Values, key: string): number | null => typeof values[key] === "number" ? values[key] : null;

// events that can be sent with just an id
type IDOnlyEvent = { [K in EventType]: { id: number } extends EventTypeDataMap[K] ? K : never }[EventType];
// events whose data is the whole stored record
type RecordEvent<R extends SnapshotResourceType> = { [K in EventType]: SnapshotTypeMap[R] extends EventTypeDataMap[K] ? K : never }[EventType];

// hides only say which record it was, the stored one is marked
function hidden<R extends SnapshotResourceType>(type: IDOnlyEvent, resource: R, key: string, changes: Partial<SnapshotTypeMap[R]>): Handler {
    return async (values, at) => {
        const id = idOf(values, key);
        if (id === null) return [];
        const before = await getSnapshot(resource, id);
        await updateSnapshot(resource, id, { ...changes, updated_at: at });
        return one(type, { id }, previous(before));
    };
}

// the record is gone, so is the stored one
function removed(type: IDOnlyEvent, resource: SnapshotResourceType, key: string): Handler {
    return async (values) => {
        const id = idOf(values, key);
        if (id === null) return [];
        const gone = await removeSnapshot(resource, id);
        return one(type, { id }, previous(gone?.data));
    };
}

// unhides and updates send the stored record with what the action changed
function changed<R extends SnapshotResourceType>(type: RecordEvent<R>, resource: R, key: string, changes: (values: Values) => Partial<SnapshotTypeMap[R]> = () => ({})): Handler {
    return async (values, at) => {
        const id = idOf(values, key);
        if (id === null) return [];
        return one(type, await updateSnapshot(resource, id, { ...changes(values), updated_at: at }) as EventTypeDataMap[typeof type] | null);
    };
}

// most user mod actions don't log the new value, so the user is fetched again. the mod action is sent with it to say what changed
function userRefetched(type: "user.destroy" | "user.update"): Handler {
    return async (values) => {
        const id = idOf(values, "user_id");
        if (id === null) return [];
        const user = await request("users lookup", () => e621.users.get(id));
        if (!user) return [];
        const before = await getSnapshot("user", id);
        await saveSnapshot("user", user);
        return one(type, user, previous(before));
    };
}

// only the name is logged
async function tagDestroyed(values: Values): Promise<Array<Extra>> {
    if (typeof values.name !== "string") return [];
    const tag = await getTagSnapshotByName(values.name);
    if (!tag) return [];
    await removeSnapshot("tag", tag.id);
    return one("tag.destroy", { id: tag.id }, previous(tag));
}

// only the name is logged, nothing else says when a help page is deleted
async function helpPageDeleted(values: Values): Promise<Array<Extra>> {
    if (typeof values.name !== "string") return [];
    const page = await getHelpPageSnapshotByName(values.name);
    if (!page) return [];
    await removeSnapshot("help_page", page.id);
    return one("help_page.destroy", { id: page.id }, previous(page));
}

// only the user is logged
async function unbanned(values: Values): Promise<Array<Extra>> {
    const userID = idOf(values, "user_id");
    if (userID === null) return [];
    const ban = await getBanSnapshotByUser(userID);
    if (!ban) return [];
    await removeSnapshot("ban", ban.id);
    return one("ban.destroy", { id: ban.id }, previous(ban));
}

// post versions are logged by post and version number, which version that is comes from post_version_index
function postVersion(type: "post_version.hide" | "post_version.unhide"): Handler {
    return async (values) => {
        const postID = idOf(values, "post_id"), number = idOf(values, "version");
        if (postID === null || number === null) return [];
        const known = await PostVersionIndex.find(postID, number);
        if (known && type === "post_version.hide") return one(type, { id: known.id });
        // unhide sends the whole version, which isn't kept. ones we don't know yet are found through the post
        const versions = known
            ? await request("post_versions lookup", () => e621.postVersions.search({ id: known.id, limit: 1 }))
            : await request("post_versions lookup", () => e621.postVersions.search({ post_id: postID, limit: 320 }));
        if (!known) await PostVersionIndex.remember(versions);
        const version = versions.find(v => v.version === number);
        if (!version) return [];
        return type === "post_version.hide" ? one(type, { id: version.id }) : one(type, version);
    };
}

const MOD_ACTIONS: Partial<Record<E621.ModAction["action"], Handler>> = {
    comment_hide: hidden("comment.hide", "comment", "comment_id", { is_hidden: true }),
    comment_unhide: changed("comment.unhide", "comment", "comment_id", () => ({ is_hidden: false })),
    comment_delete: removed("comment.destroy", "comment", "comment_id"),
    forum_topic_hide: hidden("forum_topic.hide", "forum_topic", "forum_topic_id", { is_hidden: true }),
    forum_topic_unhide: changed("forum_topic.unhide", "forum_topic", "forum_topic_id", () => ({ is_hidden: false })),
    forum_topic_delete: removed("forum_topic.destroy", "forum_topic", "forum_topic_id"),
    forum_post_hide: hidden("forum_post.hide", "forum_post", "forum_post_id", { is_hidden: true }),
    forum_post_unhide: changed("forum_post.unhide", "forum_post", "forum_post_id", () => ({ is_hidden: false })),
    forum_post_delete: removed("forum_post.destroy", "forum_post", "forum_post_id"),
    post_version_hide: postVersion("post_version.hide"),
    post_version_unhide: postVersion("post_version.unhide"),
    tag_destroy: tagDestroyed,
    help_delete: helpPageDeleted,
    artist_delete: removed("artist.destroy", "artist", "artist_id"),
    avoid_posting_delete: hidden("avoid_posting.delete", "avoid_posting", "id", { is_active: false }),
    avoid_posting_undelete: changed("avoid_posting.undelete", "avoid_posting", "id", () => ({ is_active: true })),
    avoid_posting_destroy: removed("avoid_posting.destroy", "avoid_posting", "id"),
    user_unban: unbanned,
    pool_delete: removed("pool.destroy", "pool", "pool_id"),
    set_delete: removed("post_set.destroy", "post_set", "set_id"),
    takedown_delete: removed("takedown.destroy", "takedown", "takedown_id"),
    user_feedback_delete: hidden("user_feedback.delete", "user_feedback", "record_id", { is_deleted: true }),
    user_feedback_undelete: changed("user_feedback.undelete", "user_feedback", "record_id", () => ({ is_deleted: false })),
    user_feedback_destroy: removed("user_feedback.destroy", "user_feedback", "record_id"),
    user_feedback_update: changed("user_feedback.update", "user_feedback", "record_id", values => ({
        ...typeof values.reason === "string" ? { body: values.reason } : {},
        ...typeof values.type === "string" ? { category: values.type as E621.UserFeedbackCategory } : {},
    })),
    wiki_page_delete: removed("wiki_page.destroy", "wiki_page", "wiki_page_id"),
    // deleted users are renamed, not removed
    user_delete: userRefetched("user.destroy"),
    admin_user_delete: userRefetched("user.destroy"),
    user_name_change: userRefetched("user.update"),
    user_level_change: userRefetched("user.update"),
    user_flags_change: userRefetched("user.update"),
    user_upload_limit_change: userRefetched("user.update"),
    user_karma_change: userRefetched("user.update"),
    user_karma_free_toggle: userRefetched("user.update"),
    user_uploads_toggle: userRefetched("user.update"),
    user_custom_title_change: userRefetched("user.update"),
    user_avatar_clear: userRefetched("user.update"),
    user_profile_clear: userRefetched("user.update"),
    user_text_change: userRefetched("user.update"),
    user_blacklist_changed: userRefetched("user.update"),
    user_ban_update: changed("ban.update", "ban", "ban_id", values => ({
        ...typeof values.reason === "string" ? { reason: values.reason } : {},
        ...typeof values.expires_at === "string" || values.expires_at === null ? { expires_at: values.expires_at } : {},
    })),
};

// whoever did the mod action is who changed the record
export async function modActionExtra(item: E621.ModAction): Promise<Array<Extra>> {
    const extras = await MOD_ACTIONS[item.action]?.(item.values, item.created_at) ?? [];
    const modAction = { id: item.id, action: item.action, values: item.values };
    return extras.map(extra => ({ ...extra, context: { ...extra.context, updater_id: item.creator_id, mod_action: modAction } }));
}

/** For a dnp version, which artist the entry is for. the version doesn't say */
export async function avoidPostingVersionContext(item: E621.AvoidPostingVersion): Promise<EventContext> {
    const entry = await getSnapshot("avoid_posting", item.avoid_posting_id);
    return entry ? { artist_id: entry.artist_id } : {};
}
