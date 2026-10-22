# Subscriptions

A subscription is either an event type, or `{ type, filter }`. `type` can be an exact type, `<resource>.*` (e.g. `post.*`) or `*`. You'll get an event if it matches any of your subscriptions, and every field in a filter has to match.

| filter | works on |
|---|---|
| `tags` | e621 style query (`tag`, `-tag`, `~tag`, `rating:s`/`q`/`e`). Only `post.*` and `post_version.create` have tags, nothing else will match |
| `post_ids` | anything with a post |
| `pool_ids` | `post.*` (the post's pools), `pool_version.create`, `pool.*` |
| `set_ids` | `post_set.*` |
| `topic_ids` | `forum_topic.*`, `forum_post.*`, `tag_alias.*`, `tag_implication.*`, `bulk_update_request.*`, `mod_action.create` |
| `user_ids` | the uploader, creator, updater or approver, or who it's about (`user.create`, `ban.create`, `user_feedback.create`, `upload_karma_event.create`, `post_approval.create`) |
| `actions` | `post_event.create` (`deleted`, `approved`, `flag_created`, etc) and `mod_action.create` |

See [Events](/events/) for which of these work on each event. [Private events](/events/#private-events) like `dmail.create` have to be named, `*` doesn't include them, and they can't be filtered.
