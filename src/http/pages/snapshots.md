# Snapshots

We keep a copy of every record events are built from, and you can ask for them. Send `snapshot` with a resource and the ids you want:

```json
{"op":"snapshot","d":{"resource":"post","ids":[6843484,6843485],"nonce":"abc"}}
```

```json
{"op":"snapshot","d":{"resource":"post","nonce":"abc","snapshots":{"6843484":{"resource":"post","id":6843484,"version":123,"data":{"id":6843484,"tags":{"general":["fox"]},"...":"..."}},"6843485":null},"done":true}}
```

Every id you asked for is in `snapshots`, `null` if we don't have it. Over {{snapshot_chunk}} ids are answered over several `snapshot` messages, all with the same `nonce`. Keep merging `snapshots` until one has `done: true`, events can arrive in between. `nonce` is optional (up to {{nonce_limit}} characters), it's sent back as is (or `null`) so you can tell replies apart. It counts towards your messages a minute like anything else, so ask for a bunch at once rather than one at a time.

These are what we last saw, not what's on e621 right now. `data` is the record as the api returned it, with any changes we've seen since then. `version` is a post's `change_seq`, and for everything else when it was last updated (in milliseconds).

The resources are {{snapshot_resources}}.

You can ask for up to {{max_snapshot_ids}} ids at once. An unknown resource, no ids, too many ids, or ids that aren't positive integers closes the connection with `4002`. Expunged posts, private sets and anything that's been deleted aren't kept.
