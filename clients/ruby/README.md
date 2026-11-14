# e621stream

A client for [E621Stream](https://e621.stream), using [async-websocket](https://github.com/socketry/async-websocket) and typed with sorbet.

```sh
gem install e621stream
```

```ruby
require("e621stream")

client = E621Stream::Client.new(
  username:      "your_name",
  api_key:       "your e621 api key",
  subscriptions: ["post.create", { "type" => "post.update", "filter" => { "tags" => "fox -solo" } }, "comment.*"],
)

client.on("post.create") { |event| puts(event.data["post"]["id"]) }
client.on("post.update") { |event| p(event.data["changes"]) }
client.on(:error) { |error| warn(error.message) }

client.run
```

Instead of `username:` & `api_key:`, you can pass `token:` with a token from [/authorize](https://e621.stream/authorize).

`run` blocks, unless you're already in a reactor, then it runs as a task and `client.close` stops it.

`on("post.create")` listens for one type, `on(:dispatch)` for everything. Events have `id`, `type`, `time` and `data` (the record as the api returns it), see [Events](https://e621.stream/events/). There's also `:ready`, `:replay_complete`, `:subscribed`, `:reconnecting`, `:close` and `:error`.

It reconnects when the connection drops (`reconnect: false` turns that off), and picks up from `client.cursor`. Pass `cursor:` to replay from an event id or ms timestamp. `url:` is the site (`https://e621.stream`), the websocket url comes from its `/info`, or pass a `ws://`/`wss://` url to connect to it directly. `client.subscribe([...])` changes subscriptions. Private events like `dmail.create` have to be subscribed to by name.

`client.snapshots(resource, ids) { |snapshots| ... }` gets what was last seen of up to 1000 records (see [Snapshots](https://e621.stream/snapshots/)), by id, nil for ones that aren't known. Only after `:ready`, and the block is dropped if the connection closes first.

```ruby
client.on(:ready) do
  client.snapshots("post", [6843484, 6843485]) { |posts| p(posts[6843484]&.dig("tags", "general")) }
end
```

```sh
bundle exec rake # rubocop, zeitwerk, tests & sorbet
```
