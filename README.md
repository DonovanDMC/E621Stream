# E621Stream
A (mostly) live WebSocket stream of what's happening on e621. Uploads, edits, tag changes, comments, forum posts, flags, approvals, deletions, pools, sets, wiki pages, artists, users, bans, and a lot more.

```
wss://e621.stream/ws?v=2
```

The protocol, events, filters, replaying, snapshots, compression & close codes are documented on the site, from [`src/http/pages`](./src/http/pages). There's clients for [TypeScript](./clients/typescript) and [Ruby](./clients/ruby).

```js
const ws = new WebSocket("wss://e621.stream/ws?v=2");
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

<hr>

## Running

```sh
cp .env.example .env # set the required ones at the top
mkdir logs # otherwise docker creates it as root, and nothing can write to it
docker compose up -d --build
bun run db:up # migrations
docker compose exec -it http e621stream promote owner <your e621 user id>
```

`GIT_COMMIT=$(git rev-parse HEAD) docker compose up -d --build` shows the commit on the status page and in `/info`.

| Container | |
|---|---|
| `http` | the website: docs, the status page, logging in, gateway tokens & the admin page, on `127.0.0.1:${HTTP_PORT}`. Also keeps everyone's e621 oauth links refreshed |
| `gateway` | the websocket, on `127.0.0.1:${GATEWAY_PORT}` at `/ws`. It can be scaled, connection limits are per gateway |
| `ingester` | polls e621 with the [e621](https://www.npmjs.com/package/e621) module, and runs recoveries & the backfill. Only run one |
| `egress-1` | an optional proxy that can only connect to e621, see [Egress](#egress) |
| `redis` | the event stream, cursors, feed health, status counters, slow mode, bans & cached credential checks |
| `postgres` | users, logins, gateway tokens, and the last known copy of everything events are built from. Kept forever |

Put `http` and `gateway` behind a reverse proxy, with `TRUST_PROXY=true` so client ips come from `CF-Connecting-IP`/`X-Forwarded-For`.

### This sends out everything the ingester's account can see. Use a normal account, not one with staff permissions.
`ip_addr`, `email` and the like are removed anyways, but don't rely on that.

### Configuration
Everything is set through the environment, see [`.env.example`](./.env.example). Settings only one service uses start with its name (`HTTP_`, `GATEWAY_`, `INGESTER_`, `EGRESS_`), and are read from `src/config` by `HTTPConfig`, `GatewayConfig`, `IngesterConfig` and `EgressConfig`. The rest are shared, in `Config`. Setting one of the names from before they were split stops every service with what it's called now.

### Development
`docker compose watch` (or `docker compose up --watch`) copies changes in `src` into the containers and restarts them, and rebuilds when the dependencies change.

### Commands
In the image as `e621stream`, or `bun run cli` from a checkout:

| command | |
|---|---|
| `promote <user\|admin\|owner> <user id...>` | sets e621 users' roles. Owners can only be made this way, admins can also be added from the admin page |
| `backfill status` | how far each backfill source has got |
| `backfill run <source...\|all>` | runs a source until it's done or fails |
| `backfill reset <source...\|all>` | starts a source over |
| `backfill verify [source...]` | compares a random page of what's stored with what e621 has now |

### Tests
`bun run test` runs them in the `tests` compose service, against the working tree, with its own `e621stream_test` database and redis db that are wiped every run. Nothing in them reaches e621. The gateway and http tests start the real services in their own processes.

### Clients
The clients' event types are generated from the server's, so they can't drift apart. After changing events, filters or what's stored, run `bun run client-types` and commit what it changes. The `Clients` workflow lints, builds and tests both, and `Publish Clients` releases them.

## How it works

### Feeds
Every resource is polled on its own interval, 5 seconds for posts up to 2 minutes for the quiet ones. New records are found by id, and changes by `updated_at` or by comparing against our last copy. Most changes are built from what we already have, versions, mod actions, and post events, rather than asking e621 for the record again. Events carry a `context` with what the record doesn't say itself, like who made the change, the posts added to a pool, or what a deleted record was.

Posts are polled with `order:updated`, which also changes for votes, favorites & comments. A new `change_seq` is sent as `post.update` (with who made it, from the post's version), and score/favorite/comment count changes as `post.stats`. `order:updated` isn't exactly in order, so the last 30 seconds are always read again.

The [status page](https://e621.stream/status) shows each feed's health, and admins can pause, slow down or recover individual feeds from the admin page.

### Rate Limits
e621's limit is 2 requests a second. Requests start `E621_REQUEST_INTERVAL` (550ms) apart, with at most two going at once. Every process shares the same limit through redis, including credential checks (`E621_AUTH_REQUEST_INTERVAL`, 1000ms) and private events (`GATEWAY_PRIVATE_REQUEST_INTERVAL`, 1000ms, each user every `GATEWAY_PRIVATE_POLL_INTERVAL`). Requests that take over 10 seconds are given up on and retried.

While nobody's connected and there's still backfill left, feeds are polled `INGESTER_IDLE_POLL_SCALE` (10) times slower so the backfill can have the requests. When e621 is responding slowly, slow mode on the admin page polls every feed slower without a redeploy. If `DISCORD_NOTIFICATION_WEBHOOK_URL` is set, it's posted to when the median request time over 5 minutes reaches `INGESTER_LATENCY_ALERT_MS` (2000ms), and again once it's recovered.

### Egress
e621 seems to handle requests from each ip one at a time, so a slow request holds up the next one. If the server has spare addresses, the egress service is a proxy that can only connect to e621 (over `EGRESS_FAMILY`), and `E621_EGRESS_PROXIES` lists them. Requests go through whichever route has the least going on, a proxy that fails to connect is skipped for 30 seconds. This doesn't change the rate, just how long requests spend waiting.

### Backfill
Updates need the previous copy of something to say what changed, so with `INGESTER_BACKFILL=true` the ingester stores everything from before its feeds started, through the api, newest first, using only the requests polling doesn't need. Posts alone are around 17,000 requests, so the first run takes a while, the status page and `e621stream backfill status` show how far it's got.

### Recoveries
If the ingester misses something (e621 being down for a while, or a bug), an admin can go back over that window from the admin page. What wasn't sent the first time is sent with `"recovered": true`, and clients are told when one starts and ends.

### Private Events
Dmails and changes to private sets are polled with each user's own account while they're connected, and only sent to them. They need an api key, or a gateway token with private events turned on, which needs the user's e621 oauth link to have full access.
