# e621stream

A client for [E621Stream](https://e621.stream). Works in node 22+, bun, deno & browsers, has no dependencies, and every event is typed down to the record it has.

```sh
npm i e621stream
```

```ts
import { E621Stream } from "e621stream";

const stream = new E621Stream({
    auth: { username: "your_name", apiKey: "your e621 api key" },
    subscriptions: ["post.create", { type: "post.update", filter: { tags: "fox -solo" } }, "comment.*"],
});

stream.on("post.create", (event) => {
    console.log(event.data.post.id, event.data.post.tags.general);
});
stream.on("post.update", (event) => {
    // only what changed, tags are per category
    console.log(event.data.changes?.["tags.general"]?.added);
});
stream.on("comment.update", (event) => {
    console.log(event.data.comment.id, event.data.changes?.body?.old, "->", event.data.changes?.body?.new);
});
stream.on("error", err => console.error(err));
stream.connect();
```

Listen for an event type with `on("post.create", ...)`, or everything with `on("dispatch", ...)` (check `event.type` to narrow it). The others are `ready`, `replayComplete`, `subscribed`, `reconnecting`, `close` and `error`. See [Events](https://e621.stream/events/) for what each event is.

#### Options
| Option | Type | Default | Description |
|:---:|:---:|:---:|:---:|
| `subscriptions` | Array | | what to subscribe to, `stream.subscribe([...])` changes it later |
| `auth` | Object | None | `{ username, apiKey }`, or `{ token }` from [/authorize](https://e621.stream/authorize) |
| `cursor` | String \| Number | None | an event id or ms timestamp to replay from, `stream.cursor` is the last event you got |
| `reconnect` | Boolean | `true` | reconnect when the connection drops (not after things like bad credentials) |
| `client` | String | None | shown in the server's logs |
| `url` | String | `https://e621.stream` | the websocket url comes from its `/info`, a `ws://` or `wss://` url is connected to directly |
| `fetch` | Function | global `fetch` | used for `/info` |
| `WebSocket` | WebSocket | global | for older node, the `ws` package works |

Private events like `dmail.create` have to be subscribed to by name.

`stream.snapshots(resource, ids)` gets what was last seen of up to 100 records at once (see [Snapshots](https://e621.stream/snapshots/)), keyed by id with `null` for ones that aren't known. It throws if you aren't ready yet, and rejects if the connection closes before the reply.

```ts
stream.on("ready", async () => {
    const posts = await stream.snapshots("post", [6843484, 6843485]);
    console.log(posts[6843484]?.tags?.general);
});
```

Records like `LegacyPost`, `Comment` and `ForumTopic` come from [e621-openapi](https://www.npmjs.com/package/e621-openapi)'s types, and are exported here too. Mod action events are typed per action, so checking `event.data.action` narrows `event.data.values`.
