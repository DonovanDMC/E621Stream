# Subscriptions

Each subscription is an event type string, or `{ type, filter }`. `type` can be an exact type, `<resource>.*` (for example `post.*`), or `*`. An event is delivered if it matches any of your subscriptions. Within one filter, every given field must match.

| filter field | applies to |
|---|---|
| `tags` | e621-style query (`tag`, `-tag`, `~tag`, `rating:s`/`q`/`e`). Only `post.*` and `post_version.create` have tags; any other event never matches a tag filter. |
| `post_ids` | any event tied to a post |
| `pool_ids` | `post.*` (the post's pools), `pool_version.create` and `pool.*` |
| `set_ids` | `post_set.*` |
| `topic_ids` | `forum_topic.*`, `forum_post.*`, `tag_alias.*`, `tag_implication.*`, `bulk_update_request.*`, `mod_action.create` |
| `user_ids` | the event's uploader, creator, updater or approver, or the user it's about (`user.create`, `ban.create`, `user_feedback.create`, `upload_karma_event.create`, `post_approval.create`) |
| `actions` | `post_event.create` (for example `deleted`, `approved`, `flag_created`) and `mod_action.create` |

See [Events](/events/) for every event type, and which of these filters work on each.
