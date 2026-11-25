# E621Stream

A (mostly) live WebSocket stream of what's happening on e621. Uploads, edits, tag changes, comments, forum posts, flags, approvals, deletions, pools, sets, wiki pages, artists, users, bans, and a lot more. Feeds are polled every 5-120 seconds depending on what they are, and you only get what you subscribe to.

```
{{ws_url}}?v={{protocol_version}}
```

- [Subscriptions](/subscriptions) - picking & filtering events
- [Events](/events) - every event type, and what they send
- [Replaying](/replaying) - catching up on what you missed
- [Snapshots](/snapshots) - looking up what we last saw of a post, comment, pool, etc
- [Compression](/compression)
- [Close Codes](/close-codes)
- [Clients](/clients) - libraries for TypeScript & Ruby

## Connecting

1. Connect to `/ws?v={{protocol_version}}`, optionally with `&compress=zlib-stream` or `&compress=zstd-stream` (see [Compression](/compression)). `v` is required, it's the protocol version you were written for, see [Versions](#versions).
2. You'll get `hello`.
3. Send `identify` within {{identify_timeout}} seconds, with your credentials and subscriptions.
4. You'll get `ready`, and then events as `dispatch`.

Every message is json with an `op`, and most have a `d`. Messages from the stream also have `s`, their id, and `t`, when it happened.

```js
const ws = new WebSocket("{{ws_url}}?v={{protocol_version}}");
ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.op === "hello") {
        ws.send(JSON.stringify({
            op: "identify",
            d:  {
                auth:          { token: "e6s_..." },
                subscriptions: ["post.create", { type: "post.update", filter: { tags: "fox -solo" } }],
            },
        }));
    }
    if (msg.op === "dispatch") console.log(msg.d.type, msg.s, msg.d.data);
};
```

### Authentication

{{auth_required}} There's two ways to authenticate:

- **A token.** Log in on the [Tokens](/user) page with your e621 account and make one there, then send `auth: { token }` in `identify`, or an `Authorization: Bearer <token>` header when connecting. You can have a few, with names, and delete them whenever. Deleting one disconnects anything using it.
- **An api key.** From Account > Manage API Access on e621. Send `auth: { username, api_key }` in `identify`, or an `Authorization: Basic base64(username:api_key)` header (the same as e621). They're checked against e621 and cached for {{auth_cache}} minutes.

Banned accounts can't connect. Credentials are checked again every minute, and you'll be disconnected with `4011` if they stop working.

[Private events](/events#private-events) need an api key, or a token with private events turned on, which needs full access to your account. Without them, subscribing to a private event closes with `4006`.

### Client -> Server

| op | `d` | notes |
|---|---|---|
| `identify` | `{ auth?, subscriptions, cursor?, client? }` | has to be first. `client` is a name for your client, it's only used in logs |
| `subscribe` | `{ subscriptions }` | replaces your subscriptions, answered with `subscribed` |
| `snapshot` | `{ resource, ids, nonce? }` | answered with `snapshot`, see [Snapshots](/snapshots) |
| `heartbeat` | none | optional, answered with `heartbeat_ack` |

You can send {{messages_per_minute}} messages a minute, and have up to {{max_subscriptions}} subscriptions.

### Versions

The current protocol version is {{protocol_version}}, and this server supports {{protocol_versions}}. `hello` and `/info` say which one you're getting. `v` has to be sent, so nothing is ever assumed to be on a version it wasn't written for: once a version stops being supported, connecting with it closes with `4014` instead of sending messages you'd read wrong. Leaving `v` out closes with `4014` too. Either way, your client needs updating, reconnecting won't help.

### Server -> Client

New ops and fields can be added without a version bump, ignore ones you don't know. Anything that changes or removes them is a new [version](#versions).

| op | `d` |
|---|---|
| `hello` | `{ version, session_id, identify_timeout_ms, auth_required, compression, events, private_events }` |
| `ready` | `{ session_id, user, subscriptions, replaying, cursor_expired?, recovery, slow_mode }` |
| `dispatch` | `{ type, recovered, private, data, context? }`, with the event's id as `s` and when it happened on e621 as `t`. See [Context](/events#context) |
| `replay_complete` | `{ events, cursor }` |
| `subscribed` | `{ subscriptions }` |
| `snapshot` | `{ resource, nonce, snapshots, done }` |
| `recovery` | see [Recoveries](/replaying#recoveries) |
| `slow_mode` | see [Slow Mode](#slow-mode) |
| `heartbeat_ack` | `{ cursor }`, the last event you were sent |
| `error` | `{ code, message }`, right before you're disconnected with that code |

```json
{"op":"dispatch","s":"1794179689776-0","t":"2026-11-08T17:14:26.834-06:00","d":{"type":"post.create","recovered":false,"private":false,"data":{"id":6843484,"...":"..."}}}
```

### Slow Mode

When e621 is responding slowly we can poll it slower for a while, so events arrive later than usual. Nothing's missed, they're just late. Everyone gets a `slow_mode` op when it's turned on or off:

```json
{"op":"slow_mode","s":"1794179689776-0","t":"2026-11-18T00:00:00.000Z","d":{"notice":true,"type":"slow_mode","data":{"enabled":true,"scale":3,"since":"2026-11-18T00:00:00.000Z"}}}
```

`scale` is how many times slower than usual. If you connect while it's on, `ready.d.slow_mode` has it, otherwise it's `null`. Like recoveries, these are on the stream, so a replay gets them in order and their `s` works as a cursor.

You can have {{max_connections_ip}} connections from one ip, and {{max_connections_user}} on one account.

## HTTP

| route | |
|---|---|
| `/info` | websocket url, whether auth is required, and the protocol versions it supports |
| `/health` | redis & postgres |
| `/status` | requests, events, feeds, recoveries & the backfill (`/status.json` for the data) |
