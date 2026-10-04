import { maxStreamLength, streamKey } from "./config.ts";
import redis from "./redis.ts";

export const EVENT_TYPES = [
    "artist.create",
    "artist_url.create",
    "artist_version.create",
    "avoid_posting.create",
    "avoid_posting_version.create",
    "ban.create",
    "blip.create",
    "bulk_update_request.create",
    "comment.create",
    "forum_post.create",
    "forum_topic.create",
    "mod_action.create",
    "news_update.create",
    "note.create",
    "note_version.create",
    "pool.create",
    "pool_version.create",
    "post_approval.create",
    "post_event.create",
    "post_flag.create",
    "post_replacement.create",
    "post_set.create",
    "post_version.create",
    "tag.create",
    "tag_alias.create",
    "tag_implication.create",
    "tag_type_version.create",
    "takedown.create",
    "upload_karma_event.create",
    "user.create",
    "user_feedback.create",
    "wiki_page.create",
    "wiki_page_version.create",
] as const;
export type EventType = typeof EVENT_TYPES[number];

export async function publish(type: EventType, time: string, data: unknown): Promise<string> {
    return redis.send("XADD", [streamKey, "MAXLEN", "~", String(maxStreamLength), "*", "t", type, "ts", time, "d", JSON.stringify(data)]) as Promise<string>;
}
