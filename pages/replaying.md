# Replaying

Every event `id` is a cursor. Keep the last one you got, and pass it as `cursor` in `identify` to get everything you missed. Once that's done you'll get `replay_complete`, and then live events. A millisecond timestamp works too.

Events are only kept for 24 hours. If your cursor is older than that, you'll start from the oldest one we have, and `ready.d.cursor_expired` will be `true`.

## Recoveries

If we miss something on our end (e621 being down for a while, or a bug), we can go back over that window and send what was missed. That's a recovery. You don't have to do anything, the missed events just arrive like any other, but they can be hours old so there's a few things to know.

When one starts, everyone gets a `recovery` op, and another when it's done:

```json
{"op":"recovery","id":"1794179689776-0","d":{"id":"rmh2x1k","from":"2026-11-14T02:00:00.000Z","to":"2026-11-14T08:00:00.000Z","sources":["posts","comments"],"done":false}}
{"op":"recovery","id":"1794183289776-0","d":{"id":"rmh2x1k","from":"2026-11-14T02:00:00.000Z","to":"2026-11-14T08:00:00.000Z","sources":["posts","comments"],"done":true,"status":"done","events":4821}}
```

`from`..`to` is the window being gone back over, and `sources` is which [feeds](/status/) it covers. `status` is `done`, `failed` or `cancelled`, events found before a failure or cancel are still sent. If you connect while one's running, `ready.d.recovery` has the start one, otherwise it's `null`.

Everything in between that came from the recovery has `"recovered":true`, live events keep coming as normal alongside them. Recovered events:

- have the `time` they happened, so they're out of order with everything else. Don't assume `time` only goes up
- are what we can see now, not each step. A post edited 3 times in the window is one `post.update` with every change, and a post uploaded in the window can show up as a `post.create` after you already got a `post.update` for it
- are only ones you didn't get the first time, as far as we can tell, but if something matters, dedupe by the record's id

Like the events, the `recovery` ops are on the stream, so a replay gets them in order too, and their `id` works as a cursor.
