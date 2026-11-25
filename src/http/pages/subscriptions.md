# Subscriptions

A subscription is either an event type, or `{ type, filter }`. `type` can be an exact type, `<resource>.*` (like `post.*`) or `*`. You'll get an event if it matches any of your subscriptions, and every field in a filter has to match.

```json
["comment.create", { "type": "post.*", "filter": { "tags": "fox rating:s", "pool_ids": [1234] } }]
```

Every filter but `tags` is a list of up to {{max_filter_ids}} ids, and matches if the event's matches any of them. Using a filter on an event type it doesn't work on means that subscription never matches it.

| filter | |
|---|---|
| `ids` | the record's own id |
| `tags` | an e621 style query: `tag`, `-tag`, `~tag`, `rating:s`/`q`/`e` (up to {{max_filter_tags}} tags). Only posts have tags |
| `post_ids`, `pool_ids`, `note_ids`, `wiki_page_ids`, `artist_ids`, `avoid_posting_ids`, `tag_ids` | the record, or the one it's about |
| `forum_topic_ids`, `forum_category_ids` | the topic, or the one a post, request or alias is in |
| `tag_category_ids` | a tag's category |
| `creator_ids`, `updater_ids` | who made it, or who changed it. Some of these come from the event's [context](/events#context) |
| `user_ids` | who it's about, like the user that was banned or given feedback |
| `actions` | the action, for `post_event.create` (`deleted`, `approved`, `flag_created`, etc) and `mod_action.create` |

## Which filters work on what

{{filters}}

[Private events](/events#private-events) like `dmail.create` have to be named, `*` doesn't include them, and they can't be filtered.
