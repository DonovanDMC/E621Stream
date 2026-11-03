# Events

- [Event Types](#event-types)
- [Update Events](#update-events)
- [Pool and Set Posts](#pool-and-set-posts)
- [Replacements](#replacements)
- [Mod Action Events](#mod-action-events)
- [Private Events](#private-events)

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
| `user.update`, `user.delete` | mod action, see [Mod Action Events](#mod-action-events) |
| `mod_action.create` | |
| `*.update` | see [Update events](#update-events) |
| `post_replacement.destroy` | `{ post_replacement, post_event }`, see [Replacements](#replacements) |
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
| `tag.update` | `tag_type_version.create` (category & lock changes) |

### From snapshots
Everything else is compared against the last copy we saw. `data` is `{ <resource>, changes }` (e.g. `{ comment, changes }`), with `{ old, new }` for each changed field. It's only sent when one of these fields changes:

| event | fields | how |
|---|---|---|
| `comment.update` | `body`, `is_hidden`, `is_sticky`, `warning_type`, `warning_user_id` | `updated_at`, every 30s |
| `forum_post.update` | `body`, `is_hidden`, `warning_type`, `warning_user_id` | newest 320, every 30s |
| `forum_topic.update` | `title`, `category_id`, `is_hidden`, `is_locked`, `is_sticky` | `updated_at`, every 30s |
| `tag_alias.update`, `tag_implication.update` | `status`, `antecedent_name`, `consequent_name`, `reason`, `approver_id`, `forum_topic_id` | `updated_at`, every minute |
| `bulk_update_request.update` | `status`, `title`, `script`, `approver_id`, `forum_topic_id` | `updated_at`, every minute |
| `post_set.update` | `name`, `shortname`, `description`, `is_public`, `transfer_on_delete` | `updated_at`, every minute |
| `post_flag.update` | `is_resolved` | newest 320, every minute |
| `takedown.update` | `status` | newest 320, every minute |
| `post_replacement.update` | `status`, `approver_id`, `reason`, `post_id` | newest 320, every minute, see [Replacements](#replacements) |
| `news_update.update` | `message` | newest 320, every 2 minutes |
| `help_page.update` | `name`, `title`, `wiki_page`, `related` | all of them, every 2 minutes. The text is in the wiki page, so text edits are `wiki_page.update` |

"newest 320" ones can't be sorted by `updated_at`, so anything older than that won't be caught. `changes` is `null` for comments, tag requests, BURs & replacements we didn't know about before. `comments.json` doesn't allow sorting by `updated_at` ([e621ng#2298](https://github.com/e621ng/e621ng/issues/2298)), so updated comments are found through the html listing.

### From mod actions
Only staff can edit feedback & bans, so `user_feedback.update` and `ban.update` come from the [mod action log](#mod-action-events).

## Replacements

Replacements can't be sorted by `updated_at` either, but accepting, rejecting, promoting or deleting one creates a post event (`replacement_accepted`, `replacement_rejected`, `replacement_promoted`, `replacement_deleted`). When one of those comes in, every replacement on that post gets checked.

`post_replacement.destroy` is `{ post_replacement, post_event }`, sent when a replacement we knew about is gone after a `replacement_deleted`. `post_replacement` is whatever we last knew (`id`, `status`, `approver_id`, `reason`, `post_id`), and `post_event.creator_id` is who deleted it. `post_ids` and `user_ids` filters work.

## Pool and Set Posts

| event | data | how |
|---|---|---|
| `pool.add_posts`, `pool.remove_posts` | `{ pool_version, post_ids }` | the version's `added_post_ids`/`removed_post_ids` |
| `post_set.add_posts`, `post_set.remove_posts` | `{ post_set, post_ids }` | compared against the last copy of the set we saw |

A change that adds and removes sends both. Sets we've never seen won't send these. `post_ids` matches if any of the posts do.

## Mod Action Events

Hidden & deleted records disappear from the api, so these come from the mod action log. `data` is the mod action, same as `mod_action.create`. `creator_id` is who did it (which can be someone hiding their own post), `values` depends on the action:

| event | mod action | `values` |
|---|---|---|
| `comment.hide`, `comment.unhide`, `comment.delete` | `comment_hide`, `comment_unhide`, `comment_delete` | `comment_id`, `user_id` |
| `forum_topic.hide`, `forum_topic.unhide`, `forum_topic.delete` | `forum_topic_hide`, `forum_topic_unhide`, `forum_topic_delete` | `forum_topic_id`, `forum_topic_title`, `user_id` |
| `forum_post.hide`, `forum_post.unhide`, `forum_post.delete` | `forum_post_hide`, `forum_post_unhide`, `forum_post_delete` | `forum_post_id`, `forum_topic_id`, `user_id` |
| `post_version.hide`, `post_version.unhide` | `post_version_hide`, `post_version_unhide` | `post_id`, `version` |
| `pool.delete` | `pool_delete` | `pool_id`, `pool_name`, `user_id` |
| `post_set.delete` | `set_delete` | `set_id`, `user_id` (only when staff delete someone else's set) |
| `wiki_page.delete` | `wiki_page_delete` | `wiki_page_id`, `wiki_page` |
| `artist.delete` | `artist_delete` | `artist_id`, `artist_name` |
| `avoid_posting.delete`, `avoid_posting.undelete`, `avoid_posting.destroy` | `avoid_posting_delete`, `avoid_posting_undelete`, `avoid_posting_destroy` | `id`, `artist_name` |
| `tag.delete` | `tag_destroy` | `name` |
| `user_feedback.update`, `user_feedback.delete`, `user_feedback.undelete`, `user_feedback.destroy` | `user_feedback_update`, `user_feedback_delete`, `user_feedback_undelete`, `user_feedback_destroy` | `user_id`, `reason`, `type`, `record_id`, `reason_was`/`type_was` (not on destroy) |
| `user.update` | `user_name_change`, `user_level_change`, `user_flags_change`, `user_upload_limit_change`, `user_karma_change`, `user_karma_free_toggle`, `user_uploads_toggle`, `user_custom_title_change`, `user_avatar_clear`, `user_profile_clear`, `user_text_change`, `user_blacklist_changed` | `user_id`, and the old/new values if there are any (`level`/`level_was`, etc). Only staff changes are logged, users editing their own profile won't send these |
| `user.delete` | `user_delete` (by the user), `admin_user_delete` (by staff) | `user_id` |
| `ban.update` | `user_ban_update` | `user_id`, `ban_id`, `expires_at`, `expires_at_was`, `reason`, etc |
| `ban.delete` | `user_unban` | `user_id` |
| `takedown.delete` | `takedown_delete` | `takedown_id` |

`actions` filters by mod action. `user_ids` matches `values.user_id` and `creator_id`. These go out alongside `mod_action.create`, so disabling `mod_actions` stops them too.

## Private Events

These are polled with your own credentials while you're connected, and only sent to you.

| event | data |
|---|---|
| `dmail.create` | a dmail, sent or received (check `from_id`/`to_id`) |

- They have to be subscribed to by name (or `dmail.*`), `*` doesn't include them since each one costs a request per user.
- They can't be filtered.
- Your mailbox is checked about once a minute.
- They aren't stored, so they can't be replayed, and their `id` (`dmail.create:2642532`) isn't a cursor. They have `private: true`.
- The newest one you've been sent is remembered, so reconnecting sends whatever you missed. The first time, it starts from your newest dmail. After 90 days away it starts over.
