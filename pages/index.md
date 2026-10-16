# E621Stream

A (mostly) live WebSocket stream of what's happening on e621. Uploads, edits, tag changes, comments, forum posts, flags, approvals, deletions, pools, sets, wiki pages, artists, users, bans, and a lot more. Feeds are polled every 5-120 seconds depending on what they are, and you only get what you subscribe to.

```
wss://e621.stream/ws
```

- [Subscriptions](/subscriptions/) - picking & filtering events
- [Events](/events/) - every event type, and what they send
- [Replaying](/replaying/) - catching up on what you missed
- [Compression](/compression/)
- [Close Codes](/close-codes/)
- [Clients](/clients/) - libraries for typescript & ruby

<hr>

## Connecting

1. Connect to `/ws`, optionally with `?compress=zlib-stream` or `?compress=zstd-stream` (see [Compression](/compression/)).
2. You'll get `hello`.
3. Send `identify` within 10 seconds, with your credentials and subscriptions.
4. You'll get `ready`, and then events as `dispatch`.

Every message is json with an `op`, and most have a `d`.

```js
const ws = new WebSocket("wss://e621.stream/ws");
ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.op === "hello") {
        ws.send(JSON.stringify({
            op: "identify",
            d:  {
                auth:          { username: "your_name", api_key: "your e621 api key" },
                subscriptions: ["post.create", { type: "post.update", filter: { tags: "fox -solo" } }],
            },
        }));
    }
    if (msg.op === "dispatch") console.log(msg.type, msg.id, msg.data);
};
```

### Authentication
You need a normal e621 account, with an api key from Account > Manage API Access. Banned accounts can't connect. Credentials are checked against `/users/me.json` and rechecked every 30 minutes, and you'll be disconnected with `4011` if they stop working.

Send them in `identify` as `auth: { username, api_key }`, or as an `Authorization: Basic base64(username:api_key)` header when connecting (the same as e621).

### Client -> Server

| op | payload | notes |
|---|---|---|
| `identify` | `{ auth, subscriptions, cursor?, client? }` | has to be first. `client` is a name for your client, it's only used in logs |
| `subscribe` | `{ subscriptions }` | replaces your subscriptions, answered with `subscribed` |
| `heartbeat` | none | optional, answered with `heartbeat_ack` |

### Server -> Client

| op | payload |
|---|---|
| `hello` | `{ version, session_id, identify_timeout_ms, auth_required, compression, events }` |
| `ready` | `{ session_id, user, subscriptions, replaying, cursor_expired? }` |
| `dispatch` | `id`, `type`, `time` (when it happened on e621) and `data`, not in `d` |
| `replay_complete` | `{ events, cursor }` |
| `subscribed` | `{ subscriptions }` |
| `heartbeat_ack` | `{ cursor }`, the last event you were sent |
| `error` | `{ code, message }`, right before you're disconnected with that code |

```json
{"op":"dispatch","id":"1794179689776-0","type":"post.create","time":"2026-11-08T17:14:26.834-06:00","data":{"post":{"id":6843484}}}
```

## HTTP

| route | |
|---|---|
| `/info` | websocket url, event types, compression options |
| `/health` | |
| `/stats` | connection count & the latest event |
| `/status` | requests, events, feeds & backfill (`/status.json` for the data) |
