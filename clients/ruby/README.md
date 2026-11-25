# e621stream

A client for [E621Stream](https://e621.stream), using [async-websocket](https://github.com/socketry/async-websocket) and typed with sorbet.

```sh
gem install e621stream
```

```ruby
require("e621stream")

client = E621Stream::Client.new(
  token:         "e6s_...",
  subscriptions: ["post.create", { "type" => "post.update", "filter" => { "tags" => "fox -solo" } }, "comment.*"],
)

client.on("post.create") { |event| puts(event.data["id"]) }
client.on("post.update") { |event| puts("#{event.data["id"]} edited by #{event.context&.dig("updater_id")}") }
client.on(:error) { |error| warn(error.message) }

client.run
```

Make a token on [your tokens page](https://e621.stream/user), or pass `username:` & `api_key:` instead.

`run` blocks, unless you're already in a reactor, then it runs as a task and `client.close` stops it.

`on("post.create")` listens for one type, `on(:dispatch)` for everything. Events have `id`, `type`, `time`, `data` (the record as the api returns it) and `context` (what the record doesn't say itself, like who made the change, or nil), see [Events](https://e621.stream/events). There's also `:ready`, `:replay_complete`, `:subscribed`, `:recovery`, `:slow_mode`, `:reconnecting`, `:close` and `:error`.

If the server missed events and goes back for them (a [recovery](https://e621.stream/replaying#recoveries)), `:recovery` gets the details when it starts and finishes, and the events it sends are `recovered?`. They can be hours old, so don't assume `time` only goes up.

The server can poll e621 slower for a while when it's responding slowly. `:slow_mode` gets `enabled`, `scale` and `since` when that's turned on or off, and `ready`'s `slow_mode` has it if it's already on. Events just arrive later than usual, nothing's missed.

It reconnects when the connection drops (`reconnect: false` turns that off), and picks up from `client.cursor`. Pass `cursor:` to replay from an event id or ms timestamp. `url:` is the site (`https://e621.stream`), the websocket url comes from its `/info`, or pass a `ws://`/`wss://` url to connect to it directly. `client.subscribe([...])` changes subscriptions. Private events like `dmail.create` have to be subscribed to by name, and need an api key or a token with private events turned on.

`client.snapshots(resource, ids) { |snapshots| ... }` gets what was last seen of up to 1000 records (see [Snapshots](https://e621.stream/snapshots)), by id, nil for ones that aren't known. Each has `"data"` (the record), `"id"`, `"resource"` and `"version"`. Only after `:ready`, and the block is dropped if the connection closes first.

```ruby
client.on(:ready) do
  client.snapshots("post", [6843484, 6843485]) { |posts| p(posts[6843484]&.dig("data", "tags", "general")) }
end
```

```sh
bundle exec rake # rubocop, zeitwerk, tests & sorbet
```
