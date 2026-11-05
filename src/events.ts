import { maxStreamLength, streamKey } from "./config.ts";
import { count } from "./metrics.ts";
import redis, { fieldsToObject, type StreamEntry } from "./redis.ts";

export const EVENT_TYPES = [
    "artist.create",
    "artist.delete",
    "artist.update",
    "artist_url.create",
    "artist_version.create",
    "avoid_posting.create",
    "avoid_posting.delete",
    "avoid_posting.destroy",
    "avoid_posting.undelete",
    "avoid_posting.update",
    "avoid_posting_version.create",
    "ban.create",
    "ban.delete",
    "ban.update",
    "blip.create",
    "bulk_update_request.create",
    "bulk_update_request.update",
    "comment.create",
    "comment.delete",
    "comment.hide",
    "comment.unhide",
    "comment.update",
    "forum_post.create",
    "forum_post.delete",
    "forum_post.hide",
    "forum_post.unhide",
    "forum_post.update",
    "forum_topic.create",
    "forum_topic.delete",
    "forum_topic.hide",
    "forum_topic.unhide",
    "forum_topic.update",
    "help_page.create",
    "help_page.update",
    "mod_action.create",
    "news_update.create",
    "news_update.update",
    "note.create",
    "note.update",
    "note_version.create",
    "pool.add_posts",
    "pool.create",
    "pool.delete",
    "pool.remove_posts",
    "pool.update",
    "pool_version.create",
    "post.create",
    "post.destroy",
    "post.update",
    "post_approval.create",
    "post_event.create",
    "post_flag.create",
    "post_flag.update",
    "post_replacement.create",
    "post_replacement.destroy",
    "post_replacement.update",
    "post_set.add_posts",
    "post_set.create",
    "post_set.delete",
    "post_set.remove_posts",
    "post_set.update",
    "post_version.create",
    "post_version.hide",
    "post_version.unhide",
    "tag.create",
    "tag.delete",
    "tag.update",
    "tag_alias.create",
    "tag_alias.update",
    "tag_implication.create",
    "tag_implication.update",
    "tag_type_version.create",
    "takedown.create",
    "takedown.delete",
    "takedown.update",
    "upload_karma_event.create",
    "user.create",
    "user.delete",
    "user.update",
    "user_feedback.create",
    "user_feedback.delete",
    "user_feedback.destroy",
    "user_feedback.undelete",
    "user_feedback.update",
    "wiki_page.create",
    "wiki_page.delete",
    "wiki_page.update",
    "wiki_page_version.create",
] as const;
export type EventType = typeof EVENT_TYPES[number];

// polled with each user's own credentials, `*` doesn't include these
export const PRIVATE_EVENT_TYPES = ["dmail.create"] as const;
export type PrivateEventType = typeof PRIVATE_EVENT_TYPES[number];
const privateTypeSet = new Set<string>(PRIVATE_EVENT_TYPES);
export const isPrivateEventType = (type: string): type is PrivateEventType => privateTypeSet.has(type);

// the ingester's account can't see hidden/deleted records, so these come from mod actions
export const MOD_ACTION_EVENTS: Partial<Record<string, EventType>> = {
    comment_hide: "comment.hide",
    comment_unhide: "comment.unhide",
    comment_delete: "comment.delete",
    forum_topic_hide: "forum_topic.hide",
    forum_topic_unhide: "forum_topic.unhide",
    forum_topic_delete: "forum_topic.delete",
    forum_post_hide: "forum_post.hide",
    forum_post_unhide: "forum_post.unhide",
    forum_post_delete: "forum_post.delete",
    post_version_hide: "post_version.hide",
    post_version_unhide: "post_version.unhide",
    tag_destroy: "tag.delete",
    artist_delete: "artist.delete",
    avoid_posting_delete: "avoid_posting.delete",
    avoid_posting_undelete: "avoid_posting.undelete",
    avoid_posting_destroy: "avoid_posting.destroy",
    user_unban: "ban.delete",
    pool_delete: "pool.delete",
    set_delete: "post_set.delete",
    takedown_delete: "takedown.delete",
    user_feedback_delete: "user_feedback.delete",
    user_feedback_undelete: "user_feedback.undelete",
    user_feedback_destroy: "user_feedback.destroy",
    wiki_page_delete: "wiki_page.delete",
    user_delete: "user.delete",
    admin_user_delete: "user.delete",
    // users have no updated_at
    user_name_change: "user.update",
    user_level_change: "user.update",
    user_flags_change: "user.update",
    user_upload_limit_change: "user.update",
    user_karma_change: "user.update",
    user_karma_free_toggle: "user.update",
    user_uploads_toggle: "user.update",
    user_custom_title_change: "user.update",
    user_avatar_clear: "user.update",
    user_profile_clear: "user.update",
    user_text_change: "user.update",
    user_blacklist_changed: "user.update",
    user_ban_update: "ban.update",
    user_feedback_update: "user_feedback.update",
};
export const MOD_ACTION_EVENT_TYPES = new Set<EventType>(Object.values(MOD_ACTION_EVENTS) as Array<EventType>);

export const VERSION_EVENTS: Partial<Record<EventType, EventType>> = {
    "note.update": "note_version.create",
    "pool.update": "pool_version.create",
    "wiki_page.update": "wiki_page_version.create",
    "artist.update": "artist_version.create",
    "tag.update": "tag_type_version.create",
    "avoid_posting.update": "avoid_posting_version.create",
};
const eventTypeSet = new Set<string>(EVENT_TYPES);

export function isEventType(type: string): type is EventType {
    return eventTypeSet.has(type);
}

export interface StreamEvent {
    data: Record<string, unknown>;
    id: string;
    raw: string;
    time: string;
    type: EventType;
}

export async function publish(type: EventType, time: string, data: unknown): Promise<string> {
    count("events");
    count(`events.${type}`);
    return redis.send("XADD", [streamKey, "MAXLEN", "~", String(maxStreamLength), "*", "t", type, "ts", time, "d", JSON.stringify(data)]) as Promise<string>;
}

export function parseEntry([id, fields]: StreamEntry): StreamEvent | null {
    const { t, ts, d } = fieldsToObject(fields);
    if (!t || !isEventType(t) || d === undefined) return null;
    return { id, type: t, time: ts ?? "", data: JSON.parse(d) as Record<string, unknown>, raw: d };
}

export function dispatchFrame(event: StreamEvent): string {
    return `{"op":"dispatch","id":${JSON.stringify(event.id)},"type":"${event.type}","time":${JSON.stringify(event.time)},"data":${event.raw}}`;
}
