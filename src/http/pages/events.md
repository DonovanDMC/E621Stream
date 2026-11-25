# Events

- [Event Types](#event-types)
- [Update Events](#update-events)
- [Artist URLs](#artist-urls)
- [Pool and Set Posts](#pool-and-set-posts)
- [Replacements](#replacements)
- [Mod Action Events](#mod-action-events)
- [Context](#context)
- [Private Events](#private-events)

## Event Types

`data` is the record as the api returns it. Ones that are gone, or that we only know the id of, are just `{ id }`.

| type | data |
|---|---|
| `post.create`, `post.update` | the post, with its tags by category. `post.update` is for anything that bumps `change_seq` (tags, rating, sources, description, parent, flags, replacements, pools, etc) |
| `post.stats` | the post, when its score, favorites or comment count change. There's a lot of these |
| `post.destroy` | `{ id }`, when a post is expunged. It's gone from every search, so the post event is the only sign of it |
| `post_version.create`, `post_event.create`, `post_approval.create`, `post_flag.create`, `post_replacement.create`, `upload_karma_event.create` | |
| `comment.create`, `forum_topic.create`, `forum_post.create`, `blip.create` | |
| `note.create`, `pool.create`, `post_set.create` (public only), `wiki_page.create`, `artist.create`, `artist_url.create`, `avoid_posting.create`, `tag.create`, `help_page.create`, `upload_url_rule.create`, `upload_whitelist.create` | |
| `note_version.create`, `pool_version.create`, `wiki_page_version.create`, `artist_version.create`, `avoid_posting_version.create`, `tag_type_version.create` | |
| `tag_alias.create`, `tag_implication.create`, `bulk_update_request.create` | |
| `user.create`, `user_feedback.create`, `ban.create`, `takedown.create`, `news_update.create`, `mod_action.create` | |
| `*.update` | see [Update Events](#update-events) |
| `artist_url.update`, `artist_url.destroy` | see [Artist URLs](#artist-urls) |
| `pool.add_posts`, `pool.remove_posts`, `post_set.add_posts`, `post_set.remove_posts` | see [Pool and Set Posts](#pool-and-set-posts) |
| `post_replacement.update`, `post_replacement.destroy` | see [Replacements](#replacements) |
| `upload_url_rule.destroy`, `upload_whitelist.destroy` | `{ id }`, when one we had isn't in the list anymore. The list is read whole every 2 minutes |
| `*.hide`, `*.unhide`, `*.delete`, `*.undelete`, `*.destroy`, `user.update`, `ban.update`, `user_feedback.update` | see [Mod Action Events](#mod-action-events) |

## Update Events

### From versions

Anything with a version history gets an update for every version after the first one (the first is the create). `data` is the record as it is after that version, which is our copy with the version's changes put on it. If we don't have a copy, no update is sent. The `*_version.create` event is always sent too.

| event | from | |
|---|---|---|
| `note.update` | `note_version.create` | |
| `pool.update` | `pool_version.create` | |
| `wiki_page.update` | `wiki_page_version.create` | |
| `artist.update` | `artist_version.create` | `urls` is rebuilt from the artist's urls we have |
| `avoid_posting.update` | `avoid_posting_version.create` | |
| `tag.update` | `tag_type_version.create` | category & lock changes |

### Compared with what we last saw

Everything else is compared against our copy. It's only sent when one of these fields changes, `data` is the record:

| event | fields | checked |
|---|---|---|
| `comment.update` | `body`, `is_hidden`, `is_sticky`, `warning_type`, `warning_user_id` | by `updated_at`, every 30s |
| `forum_post.update` | `body`, `is_hidden`, `warning_type`, `warning_user_id` | the newest 320, every 30s |
| `forum_topic.update` | `title`, `category_id`, `is_hidden`, `is_locked`, `is_sticky` | by `updated_at`, every 30s |
| `tag_alias.update`, `tag_implication.update` | `status`, `antecedent_name`, `consequent_name`, `reason`, `approver_id`, `forum_topic_id` | by `updated_at`, every minute |
| `bulk_update_request.update` | `status`, `title`, `script`, `approver_id`, `forum_topic_id` | by `updated_at`, every minute |
| `post_set.update` | `name`, `shortname`, `description`, `is_public`, `transfer_on_delete` | by `updated_at`, every minute |
| `post_flag.update` | `is_resolved` | the newest 320, every minute |
| `takedown.update` | `status` | the newest 320, every minute |
| `news_update.update` | `message` | the newest 320, every 2 minutes |
| `help_page.update` | `name`, `title`, `wiki_page`, `related` | all of them, every 2 minutes. The text is in the wiki page, so text edits are `wiki_page.update` |
| `upload_url_rule.update` | `label`, `pattern`, `replacement`, `message`, `handling`, `enabled` | all of them, every 2 minutes |
| `upload_whitelist.update` | `domain`, `path`, `note`, `hidden`, `allowed`, `reason` | all of them, every 2 minutes |

The "newest 320" ones can't be sorted by `updated_at`, so changes to anything older than that won't be caught. Comments, tag requests and bulk update requests we hadn't seen before are sent if they changed more than a couple seconds after being made.

## Artist URLs

Artist versions list every url the artist has, inactive ones included. Each version is compared against the urls we have: one that was turned on or off is sent as `artist_url.update`, and one that's gone as `artist_url.destroy` (`{ id, artist_id }`). New urls are `artist_url.create`, from the urls feed, which can be a minute after the version.

## Pool and Set Posts

| event | data | how |
|---|---|---|
| `pool.add_posts`, `pool.remove_posts` | the pool, as we know it after the change | from the pool's version |
| `post_set.add_posts`, `post_set.remove_posts` | the set | compared against our copy of the set |

`context.post_ids` has the posts that were added or removed, and the `post_ids` filter matches them.

A change that adds and removes sends both. Sets we've never seen won't send these.

## Replacements

Replacements can't be sorted by `updated_at` either, but accepting, rejecting, promoting or deleting one makes a post event (`replacement_accepted`, `replacement_rejected`, `replacement_promoted`, `replacement_deleted`). When one of those comes in, every replacement on that post is checked: ones that changed are sent as `post_replacement.update`, and ones we knew about that are gone as `post_replacement.destroy` (`{ id }`).

## Mod Action Events

Hidden & deleted records disappear from the api, so these come from the mod action log, and go out alongside `mod_action.create`. Turning off the `mod_actions` feed stops them too.

| event | mod action | data |
|---|---|---|
| `comment.hide`, `comment.destroy` | `comment_hide`, `comment_delete` | `{ id }` |
| `comment.unhide` | `comment_unhide` | the comment |
| `forum_topic.hide`, `forum_topic.destroy` | `forum_topic_hide`, `forum_topic_delete` | `{ id }` |
| `forum_topic.unhide` | `forum_topic_unhide` | the topic |
| `forum_post.hide`, `forum_post.destroy` | `forum_post_hide`, `forum_post_delete` | `{ id }` |
| `forum_post.unhide` | `forum_post_unhide` | the post |
| `post_version.hide`, `post_version.unhide` | `post_version_hide`, `post_version_unhide` | `{ id }`, and the version for unhide |
| `pool.destroy` | `pool_delete` | `{ id }` |
| `post_set.destroy` | `set_delete` | `{ id }` |
| `wiki_page.destroy` | `wiki_page_delete` | `{ id }` |
| `artist.destroy` | `artist_delete` | `{ id }` |
| `avoid_posting.delete`, `avoid_posting.destroy` | `avoid_posting_delete`, `avoid_posting_destroy` | `{ id }` |
| `avoid_posting.undelete` | `avoid_posting_undelete` | the entry |
| `tag.destroy` | `tag_destroy` | `{ id }`, for tags we know the name of |
| `takedown.destroy` | `takedown_delete` | `{ id }` |
| `user_feedback.delete`, `user_feedback.destroy` | `user_feedback_delete`, `user_feedback_destroy` | `{ id }` |
| `user_feedback.undelete`, `user_feedback.update` | `user_feedback_undelete`, `user_feedback_update` | the feedback |
| `user.update` | `user_name_change`, `user_level_change`, `user_flags_change`, `user_upload_limit_change`, `user_karma_change`, `user_karma_free_toggle`, `user_uploads_toggle`, `user_custom_title_change`, `user_avatar_clear`, `user_profile_clear`, `user_text_change`, `user_blacklist_changed` | the user, fetched again since most of these don't log the new value. `context.mod_action` has what was changed. Only staff changes are logged, users editing their own profile won't send these |
| `user.destroy` | `user_delete` (by the user), `admin_user_delete` (by staff) | the user, fetched again. Deleted users are renamed, not removed |
| `ban.update` | `user_ban_update` | the ban |
| `ban.destroy` | `user_unban` | `{ id }`, the user's newest ban we know of |

The ones that send a full record only do if we have a copy of it, except users, which are fetched. Every one of these has the mod action in [`context.mod_action`](#context), with its `values`.

## Context

Some events have a `context` next to `data`, for what the record doesn't say itself. It's worked out when the event is sent, and filters use it.

| field | on | from |
|---|---|---|
| `updater_id` | `note.update`, `pool.update`, `pool.add_posts`, `pool.remove_posts`, `artist.update`, `tag.update`, `artist_url.update`, `artist_url.destroy` | the version |
| `updater_id` | `artist_url.create` | the artist version that added it, when it came first |
| `updater_id` | everything from a [mod action](#mod-action-events) (`user.update`, `ban.update`, `*.hide`, etc) | who did the mod action |
| `mod_action` | everything from a [mod action](#mod-action-events) | `{ id, action, values }`, the mod action it came from. `values` says what was meant to change, like `level_was` and `level` |
| `updater_id` | `tag_alias.update`, `tag_implication.update`, `help_page.*`, `upload_whitelist.*`, `upload_url_rule.destroy` | the mod action logged for the change. Whitelist ones are matched by `note`, since that's all their mod actions show us. For tag requests without one, whoever approved it when its status changes |
| `updater_id` | `upload_url_rule.update` | the rule's `updater_id` |
| `updater_id` | `post_set.update` | the mod action for staff edits, otherwise the owner |
| `updater_id` | `bulk_update_request.update` | whoever approved or rejected it, when its status changes |
| `updater_id` | `post_replacement.update`, `post_replacement.destroy`, `post.destroy` | the post event's creator |
| `updater_id` | `post.update` | the post version made with the change. Changes that aren't edits, like approvals, don't have one |
| `post_ids` | `pool.add_posts`, `pool.remove_posts`, `post_set.add_posts`, `post_set.remove_posts` | the posts added or removed |
| `previous` | `user.update`, `user.destroy`, `post.destroy`, and every hide, delete and destroy | the record as we had it before the change, since deleted records can't be looked up and user changes don't all say what changed |
| `artist_id` | `avoid_posting_version.create` | our copy of the entry |

Fields that aren't known are left out, and `context` is left out when nothing is. `updater_ids` and `artist_ids` filters match against it on every event that has it, an event without it doesn't match them. For records that have their own `updater_id`, the context's is used when there is one, since it's who made this change.

## Private Events

These are polled with your own account while you're connected, and only sent to you.

| event | data |
|---|---|
| `dmail.create` | a dmail, sent or received (check `from_id`/`to_id`) |
| `private_post_set.add_posts`, `private_post_set.remove_posts` | one of your private sets, when posts are added or removed |

- They have to be subscribed to by name (or `dmail.*`/`private_post_set.*`), `*` doesn't include them since each one costs a request per user.
- They can't be filtered.
- They need an api key, or a token with private events turned on.
- They're checked about every {{private_poll}} seconds.
- They aren't on the stream, so they can't be replayed, and their `s` (like `dmail.create:2642532`) isn't a cursor. They have `private: true`.
- The newest dmail you've been sent is remembered, so reconnecting sends whatever you missed. The first time, it starts from your newest dmail. After 90 days away it starts over.
- Sets work like the public ones: the first time we see a set nothing is sent, after that changes are compared against the last copy. Sets that go public stop sending these, `post_set.*` covers them then.
