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

`run` blocks, unless you're already in a reactor, then it runs as a task and `client.close` stops it.

`on("post.create")` listens for one type, `on(:dispatch)` for everything. Events have `id`, `type`, `time` and `data` (the record as the api returns it), see [Events](https://e621.stream/events/). There's also `:ready`, `:replay_complete`, `:subscribed`, `:reconnecting`, `:close` and `:error`.

It reconnects when the connection drops (`reconnect: false` turns that off), and picks up from `client.cursor`. Pass `cursor:` to replay from an event id or ms timestamp. `client.subscribe([...])` changes subscriptions. Private events like `dmail.create` have to be subscribed to by name.

```sh
bundle exec rake # rubocop, zeitwerk, tests & sorbet
```
