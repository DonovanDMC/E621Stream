import type { EventDataMap } from "./generated.ts";

// keep in sync with src/events.ts

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

/** Polled with your own credentials, these need to be subscribed to by name. */

export const PRIVATE_EVENT_TYPES = [
    "dmail.create",
] as const;

export type PrivateEventType = typeof PRIVATE_EVENT_TYPES[number];

export const MOD_ACTION_EVENT_TYPES = [
    "artist.delete",
    "avoid_posting.delete",
    "avoid_posting.destroy",
    "avoid_posting.undelete",
    "ban.delete",
    "ban.update",
    "comment.delete",
    "comment.hide",
    "comment.unhide",
    "forum_post.delete",
    "forum_post.hide",
    "forum_post.unhide",
    "forum_topic.delete",
    "forum_topic.hide",
    "forum_topic.unhide",
    "pool.delete",
    "post_set.delete",
    "post_version.hide",
    "post_version.unhide",
    "tag.delete",
    "takedown.delete",
    "user.delete",
    "user.update",
    "user_feedback.delete",
    "user_feedback.destroy",
    "user_feedback.undelete",
    "user_feedback.update",
    "wiki_page.delete",
] as const;

export const VERSION_EVENT_TYPES = [
    "artist.update",
    "avoid_posting.update",
    "note.update",
    "pool.update",
    "tag.update",
    "wiki_page.update",
] as const;

export type ModActionEventType = typeof MOD_ACTION_EVENT_TYPES[number];
export type VersionEventType = typeof VERSION_EVENT_TYPES[number];

/** The data for each event type, see https://e621.stream/events/ */
export type EventData<T extends EventType | PrivateEventType> = EventDataMap[T];

export type StreamEvent<T extends EventType | PrivateEventType = EventType | PrivateEventType> = T extends EventType | PrivateEventType ? {
    data: EventData<T>;
    /** Pass this as `cursor` to resume after this event. Private events don't have one. */
    id: string;
    private?: true;
    /** When it happened on e621. */
    time: string;
    type: T;
} : never;

export interface Filter {
    actions?: Array<string>;
    pool_ids?: Array<number>;
    post_ids?: Array<number>;
    set_ids?: Array<number>;
    /** An e621 style tag query, supporting `tag`, `-tag`, `~tag` and `rating:`. */
    tags?: string;
    topic_ids?: Array<number>;
    user_ids?: Array<number>;
}

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
} as const;
