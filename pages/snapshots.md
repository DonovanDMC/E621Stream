# Snapshots

Everything that update events are compared against is kept, and you can ask for it. Send `snapshot` with a resource and up to 100 ids:

```json
{"op":"snapshot","d":{"resource":"post","ids":[6843484,6843485],"nonce":"abc"}}
```

```json
{"op":"snapshot","d":{"resource":"post","nonce":"abc","snapshots":{"6843484":{"id":6843484,"md5":"...","rating":"s","tags":{"general":["fox"]},"change_seq":123},"6843485":null}}}
```

Every id you asked for is in `snapshots`, `null` if we don't have it. `nonce` is optional, it's sent back as is (or `null`) so you can tell replies apart. It counts towards the 60 messages a minute like anything else, so ask for a bunch at once rather than one at a time.

These are what we last saw, not what's on e621 right now. They're only the fields we track, not the full record:

| resource | fields |
|---|---|
| `post` | `approver_id`, `change_seq`, `children`, `description`, `flags`, `has_notes`, `locked_tags`, `md5`, `parent_id`, `pools`, `rating`, `sources`, `tags`, `score`, `fav_count`, `comment_count` |
| everything else | the fields listed in [Update Events](/events/#from-snapshots) (`comment`, `forum_post`, `forum_topic`, `tag_alias`, `tag_implication`, `bulk_update_request`, `help_page`, `takedown`, `post_flag`, `post_set`, `news_update`, `post_replacement`) |

### An unknown resource, more than 100 ids, or ids that aren't positive integers closes the connection with `4002`.

Expunged posts and private sets aren't kept. Posts that came from the backfill might not have `score`, `fav_count` or `comment_count` until they change.
