# Clients

There's a library for typescript. It reconnects when the connection drops, and picks up from the last event it got.

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

See the [repository](https://github.com/DonovanDMC/E621Stream/tree/master/clients) for more.
