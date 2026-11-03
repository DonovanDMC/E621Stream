# E621Stream

A (mostly) live WebSocket stream of what's happening on e621. Uploads, edits, tag changes, comments, forum posts, flags, approvals, deletions, pools, sets, wiki pages, artists, users, bans, and a lot more.

```
wss://e621.stream/ws
```

See https://e621.stream for the protocol, events, filters, replaying, compression & close codes (built from [`pages/`](./pages)). There's clients for [TypeScript](./clients/typescript) and [Ruby](./clients/ruby).

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

The full protocol, every event type, filters, replaying, compression and close codes are documented at https://e621.stream.

## Running

```bash
cp .env.example .env   # fill in E621_AUTH_USER / E621_AUTH_KEY
docker compose up -d --build
```

The stack runs four containers:

- `redis` holds the event stream (a Redis stream, trimmed to `RETENTION_HOURS`), feed cursors, status page counters, and cached credential checks.
- `postgres` holds a snapshot of every record the stream tracks, which update events are diffed against. Snapshots are kept forever and replaced as records change.
- `ingester` polls e621 through the [`e621`](https://www.npmjs.com/package/e621) module, always authenticated with the configured account. Run exactly one.
- `gateway` serves the WebSocket on `127.0.0.1:3621`. Put it behind a reverse proxy for TLS, and keep `TRUST_PROXY=true` so client IPs come from `CF-Connecting-IP`/`X-Forwarded-For`. It can be scaled, but connection limits are counted per gateway process.

Everything the ingester's account can see is rebroadcast publicly, so use an account without staff permissions. Known-sensitive fields such as `ip_addr` are stripped either way.

Requests to e621 start `E621_REQUEST_INTERVAL_MS` apart (default 550ms, just under e621's 2 req/s limit), with at most two in flight so a slow connection can't bunch them up. Every process reserves its starts against one shared clock in Redis, so the ingester, the gateways' credential checks (`E621_AUTH_REQUEST_INTERVAL_MS`, default 1000ms) and private event polling (`E621_PRIVATE_REQUEST_INTERVAL_MS`, default 1000ms) stay under the limit together. Private events are polled every `PRIVATE_POLL_INTERVAL_MS` (default a minute) per connected user, by one gateway at a time. A 429 is retried after its `Retry-After`, back in the queue like any other request.

### Egress addresses

e621 works through each address's requests one at a time, so a slow request holds up the next one from the same address. If the host has spare addresses, `ROLE=egress` runs a small proxy that only tunnels to e621's API, over `EGRESS_FAMILY` (default 6), and `E621_EGRESS_PROXIES` lists them (comma separated, like `http://egress-1:8080`). Each request then goes out whichever way has the least in flight, direct or through a proxy. The total rate doesn't change, the shared limiter still spaces every start out, it just spends less time waiting. Which address a proxy leaves from is up to its Docker network, for example with `com.docker.network.host_ipv6`. The status page shows how many requests went each way and how long they took.

### Backfill

Update events need the previous state of a record to say what changed. The ingester fills in snapshots for everything from before it started, in the background, until it's caught up (`BACKFILL=false` turns this off):

- Posts, tag aliases, tag implications, BURs and post replacements come from e621's [daily DB exports](https://e621.net/db_exports), imported with `psql` through [e621-export-downloader](https://www.npmjs.com/package/e621-export-downloader). These don't use the API. The posts export is about 2GB compressed and several times that once unpacked, in the container's temp directory, while it's imported.
- Comments, forum posts and topics, post sets, flags, takedowns and news updates are crawled through the API, newest first. Crawls only get the request slots the ingester's polling leaves spare, so live events are never slowed down. Each crawl starts from wherever its live feed was when the crawl began, since the feed stores everything after that itself.

Snapshots are versioned (`change_seq` for posts, `updated_at` otherwise), so an older copy never replaces a newer one, and the backfill is safe to restart or rerun. A field an export doesn't have is left out of the snapshot, and the record's next update fills it in instead of reporting it as a change.

```bash
docker compose exec ingester bun run backfill status        # progress of each source
docker compose exec ingester bun run backfill verify        # compare stored snapshots with e621 now
docker compose exec ingester bun run backfill reset posts   # start a source over (or all)
```

### Status

`/status` shows request rates, average request time, failures and rate limits, event counts by type, each feed's last poll, and the backfill's progress. It refreshes every 15 seconds. `/status.json` has the same data.

### Logs

Each process writes its log to `logs/<role>-YYYY-MM-DD.log` (the compose file mounts `./logs`), with colors stripped and a timestamp on every line. Every request made to e621, including 429 retries, also goes to `logs/requests-<role>-YYYY-MM-DD.log`:

```
2026-11-09T18:11:23.126Z GET 200 600ms https://e621.net/forum_posts.json?limit=320&page=1 StrawberryFoxxo
```

That's the time it was sent, method, status (or `failed (<error>)`), how long it took, the URL, and the account it was made as (the ingester's, or the consumer's for credential checks). API keys are never logged. Files older than `LOG_RETENTION_DAYS` (default 14) are deleted, and `LOG_DIR=` turns file logging off. Run `mkdir logs` before the first `docker compose up`, otherwise Docker creates it owned by root and the containers can't write to it.

For local development without Docker, `bun run start` with `ROLE=all` runs both halves in one process. Set `REDIS_URL` and `LOGGER=*` for logs.

### Test client

`bun run client` connects to the local gateway and logs every packet it sends and receives, one JSON line each. It identifies with `CLIENT_USER`/`CLIENT_KEY`, or the ingester's account from `.env`, and subscribes to `*` unless you list subscriptions.

```bash
bun run client                                   # everything
bun run client post.create "comment.*" --pretty  # pick subscriptions, pretty-print
bun run client --cursor 1794244609663-0          # replay from an event id
bun run client --url wss://e621.stream/ws        # or set STREAM_URL
```

### Pages

The documentation site is built from `pages/`: each `pages/<name>.md` becomes `/<name>/`, `pages/index.md` is the home page, `pages/template.html` is the layout, and `pages/favicon.ico` is copied to the root (it's made from E621OpenAPI's icon, and the status page uses it too). `bun run build:pages` builds it into `dist-pages/`. The `Deploy Pages` workflow deploys it to `https://e621.stream` through [PagesDeployServer](https://github.com/DonovanDMC/PagesDeployServer) whenever `pages/` changes on `master`, or when run by hand.

The site and the gateway share the domain, so the reverse proxy sends `/ws`, `/health`, `/stats`, `/info`, `/status` and `/status.json` to the gateway and everything else to the pages. The gateway's service info is at `/info` (and `/` when reached directly).
