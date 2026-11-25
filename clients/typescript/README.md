# e621stream

A client for [E621Stream](https://e621.stream). Works in node 22+, bun, deno & browsers, has no dependencies, and every event is typed down to the record it has.

```sh
npm i e621stream
```

```ts
import { E621Stream } from "e621stream";

const stream = new E621Stream({
    auth: { token: "e6s_..." },
    subscriptions: ["post.create", { type: "post.update", filter: { tags: "fox -solo" } }, "comment.*"],
});

stream.on("post.create", (event) => {
    console.log(event.data.id, event.data.tags.general);
});
stream.on("post.update", (event) => {
    // context has what the record doesn't say itself, like who made the change
    console.log(event.data.id, "edited by", event.context?.updater_id);
});
stream.on("pool.add_posts", (event) => {
    console.log(event.data.name, "got", event.context?.post_ids);
});
stream.on("error", err => console.error(err));
stream.connect();
```

Listen for an event type with `on("post.create", ...)`, or everything with `on("dispatch", ...)` (check `event.type` to narrow it). The others are `ready`, `replayComplete`, `subscribed`, `recovery`, `slowMode`, `reconnecting`, `close` and `error`.

Events have `id` (a cursor for replaying), `type`, `time` (when it happened on e621), `data` (the record as the api returns it) and sometimes `context`. See [Events](https://e621.stream/events) for what each event is, and [Context](https://e621.stream/events#context) for what's in `context`.

If the server missed events and goes back for them (a [recovery](https://e621.stream/replaying#recoveries)), you get `recovery` when it starts and finishes, and the events it sends have `recovered: true`. They can be hours old, so don't assume `time` only goes up.

When e621 is responding slow the server can poll it slower for a while. `slowMode` says when that's turned on or off (and `ready.slow_mode` if it's on when you connect), events just arrive later than usual.

#### Options
| Option | Type | Default | Description |
|:---:|:---:|:---:|:---:|
| `subscriptions` | Array | | what to subscribe to, `stream.subscribe([...])` changes it later |
| `auth` | Object | None | `{ token }` from [your tokens](https://e621.stream/user), or `{ username, apiKey }` |
| `cursor` | String \| Number | None | an event id or ms timestamp to replay from, `stream.cursor` is the last event you got |
| `reconnect` | Boolean | `true` | reconnect when the connection drops (not after things like bad credentials) |
| `client` | String | None | shown in the server's logs |
| `url` | String | `https://e621.stream` | the websocket url comes from its `/info`, a `ws://` or `wss://` url is connected to directly |
| `fetch` | Function | global `fetch` | used for `/info` |
| `WebSocket` | WebSocket | global | for older node, the `ws` package works |

It connects with the protocol version it was written for (`?v=`). If the server has moved past it, the connection closes with `4014` and it doesn't reconnect, update the client.

Private events like `dmail.create` have to be subscribed to by name, and need an api key or a token with private events turned on.

`stream.snapshots(resource, ids)` gets what was last seen of up to 1000 records at once (see [Snapshots](https://e621.stream/snapshots)), keyed by id with `null` for ones that aren't known. Each has `data` (the record), `id`, `resource` and `version`. It throws if you aren't ready yet, and rejects if the connection closes before the reply.

```ts
stream.on("ready", async () => {
    const posts = await stream.snapshots("post", [6843484, 6843485]);
    console.log(posts[6843484]?.data.tags.general);
});
```

Records like `ExtendedPost`, `Comment` and `ForumTopic` come from [e621-openapi](https://www.npmjs.com/package/e621-openapi)'s types, and are exported here too. Events made from a mod action have it in `event.context.mod_action`, with the `values` it was logged with.
