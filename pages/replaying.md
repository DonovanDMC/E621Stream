# Replaying

Every event `id` is a cursor. Keep the last one you got, and pass it as `cursor` in `identify` to get everything you missed. Once that's done you'll get `replay_complete`, and then live events. A millisecond timestamp works too.

Events are only kept for 24 hours. If your cursor is older than that, you'll start from the oldest one we have, and `ready.d.cursor_expired` will be `true`.
