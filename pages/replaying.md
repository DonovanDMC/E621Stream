# Replaying

Each event `id` is a cursor. Store the last `id` you processed and pass it as `cursor` in `identify` to receive everything you missed, followed by `replay_complete`, before live events resume. A millisecond timestamp also works as a cursor. Events are kept for 24 hours; if your cursor is older than that, replay starts at the oldest kept event and `ready.d.cursor_expired` is `true`.
