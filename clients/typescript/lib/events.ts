import type { EventContext, EventTypeDataMap, Filter, PrivateEventTypeDataMap } from "./generated.ts";

// the two lists and PROTOCOL_VERSION here are rewritten by `bun run client-types` in the server repo, everything else is by hand

/** The protocol version this client speaks, sent as `?v=` when connecting */
export const PROTOCOL_VERSION = 2;

export const EVENT_TYPES = [
    "artist.create",
    "artist.destroy",
    "artist.update",
    "artist_url.create",
    "artist_url.destroy",
    "artist_url.update",
    "artist_version.create",
    "avoid_posting.create",
    "avoid_posting.delete",
    "avoid_posting.destroy",
    "avoid_posting.undelete",
    "avoid_posting.update",
    "avoid_posting_version.create",
    "ban.create",
    "ban.destroy",
    "ban.update",
    "blip.create",
    "blip.delete",
    "blip.destroy",
    "blip.undelete",
    "blip.update",
    "bulk_update_request.create",
    "bulk_update_request.update",
    "comment.create",
    "comment.destroy",
    "comment.hide",
    "comment.unhide",
    "comment.update",
    "forum_category.create",
    "forum_category.destroy",
    "forum_category.update",
    "forum_post.create",
    "forum_post.destroy",
    "forum_post.hide",
    "forum_post.unhide",
    "forum_post.update",
    "forum_topic.create",
    "forum_topic.destroy",
    "forum_topic.hide",
    "forum_topic.unhide",
    "forum_topic.update",
    "help_page.create",
    "help_page.destroy",
    "help_page.update",
    "mod_action.create",
    "news_update.create",
    "news_update.destroy",
    "news_update.update",
    "note.create",
    "note.delete",
    "note.undelete",
    "note.update",
    "note_version.create",
    "pool.add_posts",
    "pool.create",
    "pool.destroy",
    "pool.remove_posts",
    "pool.update",
    "pool_version.create",
    "post.create",
    "post.destroy",
    "post.stats",
    "post.update",
    "post_approval.create",
    "post_approval.destroy",
    "post_event.create",
    "post_flag.create",
    "post_flag.update",
    "post_replacement.create",
    "post_replacement.destroy",
    "post_replacement.update",
    "post_set.add_posts",
    "post_set.create",
    "post_set.destroy",
    "post_set.remove_posts",
    "post_set.update",
    "post_version.create",
    "post_version.hide",
    "post_version.unhide",
    "tag.create",
    "tag.destroy",
    "tag.update",
    "tag_type_version.create",
    "tag_alias.create",
    "tag_alias.update",
    "tag_implication.create",
    "tag_implication.update",
    "takedown.create",
    "takedown.destroy",
    "takedown.update",
    "upload_karma_event.create",
    "upload_url_rule.create",
    "upload_url_rule.destroy",
    "upload_url_rule.update",
    "upload_whitelist.create",
    "upload_whitelist.destroy",
    "upload_whitelist.update",
    "user.create",
    "user.destroy",
    "user.update",
    "user_feedback.create",
    "user_feedback.delete",
    "user_feedback.destroy",
    "user_feedback.undelete",
    "user_feedback.update",
    "wiki_page.create",
    "wiki_page.destroy",
    "wiki_page.update",
    "wiki_page_version.create",
] as const;

export type EventType = typeof EVENT_TYPES[number];

export const PRIVATE_EVENT_TYPES = [
    "dmail.create",
    "private_post_set.add_posts",
    "private_post_set.remove_posts",
] as const;

export type PrivateEventType = typeof PRIVATE_EVENT_TYPES[number];

export type EventData<T extends EventType | PrivateEventType> = T extends EventType ? EventTypeDataMap[T] : T extends PrivateEventType ? PrivateEventTypeDataMap[T] : never;

export type StreamEvent<T extends EventType | PrivateEventType = EventType | PrivateEventType> = T extends EventType | PrivateEventType ? {
    /** What the record doesn't say itself, like who made the change */
    context?: EventContext;
    data: EventData<T>;
    /** The event's id, a cursor for replaying. Private events have one too, but it isn't a cursor */
    id: string;
    private?: true;
    recovered?: true;
    /** When it happened on e621 */
    time: string;
    type: T;
} : never;

export type Subscription = string | { filter?: Filter; type: string };

export const CloseCodes = {
    UNKNOWN_ERROR: 4000,
    UNKNOWN_OP: 4001,
    DECODE_ERROR: 4002,
    NOT_IDENTIFIED: 4003,
    AUTHENTICATION_FAILED: 4004,
    ALREADY_IDENTIFIED: 4005,
    INVALID_SUBSCRIPTION: 4006,
    INVALID_CURSOR: 4007,
    RATE_LIMITED: 4008,
    SLOW_CONSUMER: 4009,
    TOO_MANY_CONNECTIONS: 4010,
    AUTHENTICATION_EXPIRED: 4011,
    DISCONNECTED: 4012,
    BANNED: 4013,
    UNSUPPORTED_VERSION: 4014,
} as const;
