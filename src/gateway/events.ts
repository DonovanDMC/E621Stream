import Config from "../Config.ts";
import Redis, { objectToFields, parseEntry, type StreamEntry } from "../db/Redis.ts";
import { count } from "../util/metrics.ts";
import { Tuple } from "../util/util.ts";

import { isRecovering, type RecoveryNotice } from "./recovery.ts";

import type { SlowModeNotice } from "./slowMode.ts";
import type * as E621 from "e621-openapi/types";

export const streamKey = `${Config.redisPrefix}events`;
export const EVENT_TYPES = Tuple([
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
    "note.undelete", // made from note.update for convinence
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
] as const);
export type EventType = typeof EVENT_TYPES[number];

type IDOnly<T extends { id: number }> = Partial<Omit<T, "id">> & Pick<T, "id">;
// used for applying filters
export interface EventTypeDataMap {
    "artist.create": E621.Artist;
    "artist.destroy": IDOnly<E621.Artist>;
    "artist.update": E621.Artist;
    "artist_url.create": E621.ArtistURL;
    "artist_url.destroy": IDOnly<E621.ArtistURL>;
    "artist_url.update": E621.ArtistURL;
    "artist_version.create": E621.ArtistVersion;
    "avoid_posting.create": E621.AvoidPosting;
    "avoid_posting.delete": IDOnly<E621.AvoidPosting>;
    "avoid_posting.destroy": IDOnly<E621.AvoidPosting>;
    "avoid_posting.undelete": E621.AvoidPosting;
    "avoid_posting.update": E621.AvoidPosting;
    "avoid_posting_version.create": E621.AvoidPostingVersion;
    "ban.create": E621.Ban;
    "ban.destroy": IDOnly<E621.Ban>;
    "ban.update": E621.Ban;
    "blip.create": E621.Blip;
    "blip.delete": IDOnly<E621.Blip>;
    "blip.destroy": IDOnly<E621.Blip>;
    "blip.undelete": E621.Blip;
    "blip.update": E621.Blip;
    "bulk_update_request.create": E621.BulkUpdateRequest;
    "bulk_update_request.update": E621.BulkUpdateRequest;
    "comment.create": E621.Comment;
    "comment.destroy": IDOnly<E621.Comment>;
    "comment.hide": IDOnly<E621.Comment>;
    "comment.unhide": E621.Comment;
    "comment.update": E621.Comment;
    "forum_category.create": never;
    "forum_category.destroy": never;
    "forum_category.update": never;
    "forum_post.create": E621.ForumPost;
    "forum_post.destroy": IDOnly<E621.ForumPost>;
    "forum_post.hide": IDOnly<E621.ForumPost>;
    "forum_post.unhide": E621.ForumPost;
    "forum_post.update": E621.ForumPost;
    "forum_topic.create": E621.ForumTopic;
    "forum_topic.destroy": IDOnly<E621.ForumTopic>;
    "forum_topic.hide": IDOnly<E621.ForumTopic>;
    "forum_topic.unhide": E621.ForumTopic;
    "forum_topic.update": E621.ForumTopic;
    "help_page.create": E621.HelpPage;
    "help_page.destroy": IDOnly<E621.HelpPage>;
    "help_page.update": E621.HelpPage;
    "mod_action.create": E621.ModAction;
    "news_update.create": E621.NewsUpdate;
    "news_update.destroy": IDOnly<E621.NewsUpdate>;
    "news_update.update": E621.NewsUpdate;
    "note.create": E621.Note;
    "note.delete": E621.Note;
    "note.undelete": E621.Note;
    "note.update": E621.Note;
    "note_version.create": E621.NoteVersion;
    "pool.add_posts": E621.Pool;
    "pool.create": E621.Pool;
    "pool.destroy": IDOnly<E621.Pool>;
    "pool.remove_posts": E621.Pool;
    "pool.update": E621.Pool;
    "pool_version.create": E621.PoolVersion;
    "post.create": E621.ExtendedPost;
    "post.destroy": IDOnly<E621.ExtendedPost>;
    "post.stats": E621.ExtendedPost;
    "post.update": E621.ExtendedPost;
    "post_approval.create": E621.PostApproval;
    "post_approval.destroy": IDOnly<E621.PostApproval>;
    "post_event.create": E621.PostEvent;
    "post_flag.create": E621.PostFlag;
    "post_flag.update": E621.PostFlag;
    "post_replacement.create": E621.PostReplacement;
    "post_replacement.destroy": IDOnly<E621.PostReplacement>;
    "post_replacement.update": E621.PostReplacement;
    "post_set.add_posts": E621.PostSet;
    "post_set.create": E621.PostSet;
    "post_set.destroy": IDOnly<E621.PostSet>;
    "post_set.remove_posts": E621.PostSet;
    "post_set.update": E621.PostSet;
    "post_version.create": E621.PostVersion;
    "post_version.hide": IDOnly<E621.PostVersion>;
    "post_version.unhide": E621.PostVersion;
    "tag.create": E621.Tag;
    "tag.destroy": IDOnly<E621.Tag>;
    "tag.update": E621.Tag;
    "tag_alias.create": E621.TagAlias;
    "tag_alias.update": E621.TagAlias;
    "tag_implication.create": E621.TagImplication;
    "tag_implication.update": E621.TagImplication;
    "tag_type_version.create": E621.TagTypeVersion;
    "takedown.create": E621.Takedown;
    "takedown.destroy": IDOnly<E621.Takedown>;
    "takedown.update": E621.Takedown;
    "upload_karma_event.create": E621.UploadKarmaEvent;
    "upload_url_rule.create": E621.UploadURLRule;
    "upload_url_rule.destroy": IDOnly<E621.UploadURLRule>;
    "upload_url_rule.update": E621.UploadURLRule;
    "upload_whitelist.create": E621.UploadWhitelist;
    "upload_whitelist.destroy": IDOnly<E621.UploadWhitelist>;
    "upload_whitelist.update": E621.UploadWhitelist;
    "user.create": E621.User;
    "user.destroy": E621.User;
    "user.update": E621.User;
    "user_feedback.create": E621.UserFeedback;
    "user_feedback.delete": IDOnly<E621.UserFeedback>;
    "user_feedback.destroy": IDOnly<E621.UserFeedback>;
    "user_feedback.undelete": E621.UserFeedback;
    "user_feedback.update": E621.UserFeedback;
    "wiki_page.create": E621.WikiPage;
    "wiki_page.destroy": IDOnly<E621.WikiPage>;
    "wiki_page.update": E621.WikiPage;
    "wiki_page_version.create": E621.WikiPageVersion;
}

export const PRIVATE_EVENT_TYPES = Tuple([
    "dmail.create",
    "private_post_set.add_posts",
    "private_post_set.remove_posts",
] as const);
export type PrivateEventType = (typeof PRIVATE_EVENT_TYPES)[number];
// private sets carry the set like the public ones do
export interface PrivateEventTypeDataMap {
    "dmail.create": E621.DMail;
    "private_post_set.add_posts": E621.PostSet;
    "private_post_set.remove_posts": E621.PostSet;
}

/** What the record doesn't say, worked out when it's published. It's sent along with the event, and filters use it */
export interface EventContext {
    artist_id?: number;
    /** The mod action it came from, its values say what was meant to change */
    mod_action?: { action: string; id: number; values: Record<string, unknown> };
    /** Posts added or removed, for pools and sets */
    post_ids?: Array<number>;
    /** What we had stored before the change, for deletions and changes we can't see the details of */
    previous?: Record<string, unknown>;
    /** Who made the change, from the version or mod action it came from */
    updater_id?: number;
}

export interface StreamEvent<T extends EventType = EventType> {
    context?: EventContext;
    data: EventTypeDataMap[T];
    id: string;
    recovered: boolean;
    time: string; // ISO timestamp
    type: T;
}

export interface Notice<T extends NoticeType> {
    id: string;
    notice: true;
    time: string; // ISO timestamp
    type: T;
}

export const NOTICE_TYPES = ["recovery", "slow_mode"] as const;
export type NoticeType = (typeof NOTICE_TYPES)[number];

export type StreamNotice = RecoveryNotice | SlowModeNotice;
export type StreamItem = StreamEvent | StreamNotice;

// what's left of a notice once the stream fills in the rest
export type NoticeData<T extends NoticeType> = Omit<Extract<StreamNotice, { type: T }>, "id" | "notice" | "time" | "type">;
export async function publishNotice<T extends NoticeType>(type: T, data: NoticeData<T>): Promise<string> {
    const fields = objectToFields({ notice: true, type, time: new Date().toISOString(), ...data });
    return await Redis.send("XADD", [streamKey, "MAXLEN", "~", String(Config.replayLimit), "*", ...fields]) as string;
}

export async function publish<T extends EventType>(type: T, time: string, data: EventTypeDataMap[T], context?: EventContext): Promise<string> {
    const recovered = isRecovering();
    count("events");
    count(`events.${type}`);
    if (recovered) count("events.recovered");
    // only stored when there's something in it
    const fields = objectToFields({ type, time, recovered, data, ...context && Object.keys(context).length !== 0 ? { context } : {} });
    return await Redis.send("XADD", [streamKey, "MAXLEN", "~", String(Config.replayLimit), "*", ...fields]) as string;
}

const LATEST_LOOKBACK = 20;
/** The newest event on the stream, notices are skipped */
export async function latestEvent(): Promise<{ id: string; time: string } | null> {
    const entries = await Redis.send("XREVRANGE", [streamKey, "+", "-", "COUNT", String(LATEST_LOOKBACK)]) as Array<StreamEntry>;
    const event = entries.map(parseEntry).find(item => item && !("notice" in item));
    return event ? { id: event.id, time: event.time } : null;
}
