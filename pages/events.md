# Events

- [Event Types](#event-types)
- [Update Events](#update-events)
- [Pool and Set Posts](#pool-and-set-posts)
- [Mod Action Events](#mod-action-events)

## Event Types

| type | data |
|---|---|
| `post.create` | `{ post }`: a new upload |
| `post.update` | `{ post, changes }`: anything that bumps the post's `change_seq` (tags, rating, sources, description, parent, flags, file replacement, pools, …). `changes` maps each field (tags per category, e.g. `tags.general`) to `{ added, removed }` or `{ old, new }`. It is `null` when the previous state isn't known. |
| `post_version.create` | a post version (who changed tags/rating/source/description) |
| `post_event.create` | approvals, deletions, undeletions, flags, locks, replacements, … (`action`) |
| `post_approval.create`, `post_flag.create`, `post_replacement.create`, `upload_karma_event.create` | |
| `comment.create`, `forum_topic.create`, `forum_post.create`, `blip.create` | |
| `note.create`, `pool.create`, `post_set.create` (public sets only), `wiki_page.create`, `artist.create`, `artist_url.create`, `avoid_posting.create`, `tag.create`, `help_page.create` | |
| `note_version.create`, `pool_version.create`, `wiki_page_version.create`, `artist_version.create`, `avoid_posting_version.create`, `tag_type_version.create` | |
| `tag_alias.create`, `tag_implication.create`, `bulk_update_request.create` | |
| `user.create`, `user_feedback.create`, `ban.create`, `takedown.create`, `news_update.create` | |
| `mod_action.create` | |
| `*.update` | see [Update events](#update-events) |
| `pool.add_posts`, `pool.remove_posts`, `post_set.add_posts`, `post_set.remove_posts` | see [Pool and set posts](#pool-and-set-posts) |
| `*.hide`, `*.unhide`, `*.delete`, `*.undelete`, `*.destroy` | mod action, see [Mod action events](#mod-action-events) |

Except for posts and the update events, `data` is the record exactly as e621's API returns it.

## Update Events

Updates come from one of three places, depending on what e621 offers for the resource.

**From versions.** Resources with a version history publish an update for every version after the first (the first is the record being created, which the create event covers). `data` is the version record, the same one the matching `*_version.create` sends, and filters apply as they do to it:

| event | from |
|---|---|
| `note.update` | `note_version.create` |
| `pool.update` | `pool_version.create` |
| `wiki_page.update` | `wiki_page_version.create` |
| `artist.update` | `artist_version.create` |
| `avoid_posting.update` | `avoid_posting_version.create` |
| `tag.update` | `tag_type_version.create` (category and lock changes) |

**From snapshots.** Everything else is compared against the last state the stream saw. These wrap the record under its resource name, e.g. `{ comment, changes }` or `{ tag_alias, changes }`. `changes` maps each changed field to `{ old, new }`, and filters apply to the wrapped record. An update fires only when one of these fields changes:

| event | tracked fields | how it's found |
|---|---|---|
| `comment.update` | `body`, `is_hidden`, `is_sticky`, `warning_type`, `warning_user_id` | polled by `updated_at` every 30 seconds |
| `forum_post.update` | `body`, `is_hidden`, `warning_type`, `warning_user_id` | the newest 320 forum posts are rescanned every 30 seconds |
| `forum_topic.update` | `title`, `category_id`, `is_hidden`, `is_locked`, `is_sticky` | polled by `updated_at` every 30 seconds; reply bumps don't count |
| `tag_alias.update`, `tag_implication.update` | `status`, `antecedent_name`, `consequent_name`, `reason`, `approver_id`, `forum_topic_id` | polled by `updated_at` every minute |
| `bulk_update_request.update` | `status`, `title`, `script`, `approver_id`, `forum_topic_id` | polled by `updated_at` every minute |
| `post_set.update` | `name`, `shortname`, `description`, `is_public`, `transfer_on_delete` | polled by `updated_at` every minute; adding or removing posts is sent as `post_set.add_posts`/`remove_posts` instead |
| `post_flag.update` | `is_resolved` | the newest 320 flags are rescanned every minute |
| `takedown.update` | `status` | the newest 320 takedowns are rescanned every minute |
| `news_update.update` | `message` | the newest 320 news updates are rescanned every 2 minutes |
| `help_page.update` | `name`, `title`, `wiki_page`, `related` | the whole help list is rescanned every 2 minutes. Help page text lives in its wiki page, so text edits come through as `wiki_page.update` |

Forum posts, flags, takedowns and news updates can't be ordered by `updated_at`, so their changes are only caught while the record is still in that rescanned window. `comments.json` blocks `updated_at` ordering, so updated comments are found through the HTML comment listing and then fetched as JSON. For comments, tag requests and BURs changed before the stream knew their previous state, `changes` is `null`.

**From the mod action log.** User feedback and bans can only be edited by staff, so `user_feedback.update` and `ban.update` come from the [mod action log](#mod-action-events).

## Pool and Set Posts

`pool.add_posts`/`pool.remove_posts` and `post_set.add_posts`/`post_set.remove_posts` fire when posts are added to or removed from a pool or set, and `post_ids` lists them. One change that does both sends both.

| event | data | how it's found |
|---|---|---|
| `pool.add_posts`, `pool.remove_posts` | `{ pool_version, post_ids }` | each pool version's `added_post_ids`/`removed_post_ids`, including the pool's first version |
| `post_set.add_posts`, `post_set.remove_posts` | `{ post_set, post_ids }` | the set's `post_ids` compared against the last state the stream saw, with the same polling as `post_set.update` |

A set's posts are only known once the stream has seen the set, so changes to a set it has never seen (or whose snapshot expired) aren't sent. `post_ids`, `pool_ids`, `set_ids` and `user_ids` filters work on these, and `post_ids` matches if any of the listed posts do.

## Mod Action Events

Hidden and deleted records disappear from e621's API, and some changes are only recorded as mod actions, so these events come from the mod action log. `data` is the mod action (the same record `mod_action.create` sends). `creator_id` is whoever did it, which can be the author hiding their own post. What the action applies to is in `values`:

| event | mod action | `values` |
|---|---|---|
| `comment.hide`, `comment.unhide`, `comment.delete` | `comment_hide`, `comment_unhide`, `comment_delete` | `comment_id`, `user_id` |
| `forum_topic.hide`, `forum_topic.unhide`, `forum_topic.delete` | `forum_topic_hide`, `forum_topic_unhide`, `forum_topic_delete` | `forum_topic_id`, `forum_topic_title`, `user_id` |
| `forum_post.hide`, `forum_post.unhide`, `forum_post.delete` | `forum_post_hide`, `forum_post_unhide`, `forum_post_delete` | `forum_post_id`, `forum_topic_id`, `user_id` |
| `post_version.hide`, `post_version.unhide` | `post_version_hide`, `post_version_unhide` | `post_id`, `version` |
| `pool.delete` | `pool_delete` | `pool_id`, `pool_name`, `user_id` |
| `post_set.delete` | `set_delete` | `set_id`, `user_id`. Only logged when staff delete someone else's set |
| `wiki_page.delete` | `wiki_page_delete` | `wiki_page_id`, `wiki_page` |
| `artist.delete` | `artist_delete` | `artist_id`, `artist_name` |
| `avoid_posting.delete`, `avoid_posting.undelete`, `avoid_posting.destroy` | `avoid_posting_delete`, `avoid_posting_undelete`, `avoid_posting_destroy` | `id`, `artist_name` |
| `tag.delete` | `tag_destroy` | `name` |
| `user_feedback.update`, `user_feedback.delete`, `user_feedback.undelete`, `user_feedback.destroy` | `user_feedback_update`, `user_feedback_delete`, `user_feedback_undelete`, `user_feedback_destroy` | `user_id`, `reason`, `type`, `record_id`, and `reason_was`/`type_was` except for destroy |
| `ban.update` | `user_ban_update` | `user_id`, `ban_id`, `expires_at`, `expires_at_was`, `reason`, … |
| `ban.delete` | `user_unban` | `user_id` |
| `takedown.delete` | `takedown_delete` | `takedown_id` |

`user_id` is the record's author, or the user it's about. `topic_ids`, `pool_ids`, `set_ids`, `post_ids` and `user_ids` filters match on `values` (and `user_ids` on `creator_id`). These are published alongside `mod_action.create`, so they stop if `mod_actions` is in `DISABLED_SOURCES`.
