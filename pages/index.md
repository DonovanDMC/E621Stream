# E621Stream

A semi-live WebSocket stream of e621 activity: uploads, post edits, tag changes, comments, forum posts, flags, approvals, deletions, new pools, sets, wiki pages, artists, users, bans, and more. e621 is polled every 5–120 seconds depending on the feed, and each change is pushed only to the consumers subscribed to it.

Public endpoint: `wss://e621.stream/ws`

- [Subscriptions](/subscriptions/): choosing which events you get, and filtering them
- [Events](/events/): every event type and what it sends
- [Replaying](/replaying/): catching up on what you missed
- [Compression](/compression/)
- [Close Codes](/close-codes/)

## Connecting

1. Open a WebSocket to `/ws`. You can add `?compress=zlib-stream` or `?compress=zstd-stream` (see [Compression](/compression/)).
2. The server sends `hello`.
3. Within 10 seconds, send `identify` with your e621 credentials and subscriptions.
4. The server replies with `ready`, then sends `dispatch` events.

Every message is a JSON object with an `op`. Most also carry a `d` payload.

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

Connections authenticate with a normal e621 account, using the API key from Account → Manage API Access. The credentials are checked against `/users/me.json`. A successful check is cached for 30 minutes and then re-checked, and a connection whose credentials stop working is closed with `4011`. Banned accounts are rejected.

Send the credentials in `identify` as `auth: { username, api_key }`, or send an `Authorization: Basic base64(username:api_key)` header when connecting (the same format e621 uses).

### Client → Server

| op | payload | notes |
|---|---|---|
| `identify` | `{ auth, subscriptions, cursor?, client? }` | Must be sent once, first. `client` is a free-form name used in logs. |
| `subscribe` | `{ subscriptions }` | Replaces the current subscriptions without reconnecting. Answered with `subscribed`. |
| `heartbeat` | none | Optional. Answered with `heartbeat_ack` holding the id of the last event sent to you. Protocol-level pings keep the socket alive either way. |

### Server → Client

| op | payload |
|---|---|
| `hello` | `{ version, session_id, identify_timeout_ms, auth_required, compression, events }` |
| `ready` | `{ session_id, user, subscriptions, replaying, cursor_expired? }` |
| `dispatch` | top-level `id`, `type`, `time` (when it happened on e621) and `data` |
| `replay_complete` | `{ events, cursor }`: replay is done and live events follow |
| `subscribed` | `{ subscriptions }` |
| `heartbeat_ack` | `{ cursor }` |
| `error` | `{ code, message }`, sent right before the socket closes with the same code |

```json
{"op":"dispatch","id":"1794179689776-0","type":"post.create","time":"2026-11-08T17:14:26.834-06:00","data":{"post":{"id":6843484}}}
```

## HTTP

- `GET /info`: service info (WebSocket URL, event types, compression options)
- `GET /health`: health check
- `GET /stats`: connection count and the latest event
