# Clients

There's libraries for typescript and ruby. Both reconnect when the connection drops, and pick up from the last event they got.

## TypeScript
[e621stream on npm](https://www.npmjs.com/package/e621stream), for node 22+, bun, deno & browsers. No dependencies, and every event is fully typed.

```sh
npm i e621stream
```

```ts
import { E621Stream } from "e621stream";

const stream = new E621Stream({
    auth: { username: "your_name", apiKey: "your e621 api key" },
    subscriptions: ["post.create", "comment.*"],
});
stream.on("post.create", event => console.log(event.data.post.id));
stream.connect();
```

## Ruby
[e621stream on rubygems](https://rubygems.org/gems/e621stream), using async-websocket, typed with sorbet.

```sh
gem install e621stream
```

```ruby
require("e621stream")

client = E621Stream::Client.new(username: "your_name", api_key: "your e621 api key", subscriptions: ["post.create", "comment.*"])
client.on("post.create") { |event| puts(event.data["post"]["id"]) }
client.run
```

See the [repository](https://github.com/DonovanDMC/E621Stream/tree/master/clients) for more.
