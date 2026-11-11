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

<hr>

## Running

```sh
cp .env.example .env # set E621_AUTH_USER & E621_AUTH_KEY
mkdir logs # otherwise docker creates it as root, and nothing can write to it
docker compose up -d --build
```

| Container | |
|---|---|
| `redis` | the event stream (trimmed to `RETENTION_HOURS`), cursors, status counters & cached credential checks |
| `postgres` | the last known copy of everything, which updates are compared against. Kept forever |
| `ingester` | polls e621 with the [e621](https://www.npmjs.com/package/e621) module. Only run one |
| `gateway` | the websocket, on `127.0.0.1:3621`. Put it behind a reverse proxy, client ips come from `CF-Connecting-IP`/`X-Forwarded-For` when `TRUST_PROXY=true`. It can be scaled, but connection limits are per gateway |

### This rebroadcasts everything the ingester's account can see. Use a normal account, not one with staff permissions.

`ip_addr` and the like are removed anyways, but don't rely on that.

For development, `bun run start` with `ROLE=all` runs everything in one process (set `REDIS_URL`, and `LOGGER=*` for logs).

### Rate Limits
e621's limit is 2 requests a second. Requests start `E621_REQUEST_INTERVAL_MS` (550ms) apart, with at most two going at once. Every process shares the same limit through redis, including credential checks (`E621_AUTH_REQUEST_INTERVAL_MS`, 1000ms) and private events (`E621_PRIVATE_REQUEST_INTERVAL_MS`, 1000ms, each user every `PRIVATE_POLL_INTERVAL_MS`). 429s wait for `Retry-After` and go back in the queue.

While nobody's connected and there's still backfill left, feeds are polled `IDLE_POLL_SCALE` (10) times slower so the backfill can have the requests.

### Egress
e621 seems to handle requests from each ip one at a time, so a slow request holds up the next one. If the server has spare addresses, `ROLE=egress` runs a proxy that can only connect to e621 (over `EGRESS_FAMILY`, 6 by default), and `E621_EGRESS_PROXIES` lists them (`http://egress-1:8080,http://egress-2:8080`). Requests go through whichever has the least going on, and only go direct if none are working. This doesn't change the rate, just how long requests spend waiting. The docker network decides which address a proxy uses (`com.docker.network.host_ipv6`).

### Posts
Posts are polled with `order:updated`, which also changes for votes, favorites & comments. A new `change_seq` is sent as `post.update`, and score/favorite/comment count changes as `post.stats`. `order:updated` isn't exactly in order, so the last 30 seconds are always read again.

### Backfill
Updates need the previous copy of something to say what changed, so the ingester fills in everything from before it started, in the background (`BACKFILL=false` turns it off).

- Posts, tag aliases, tag implications, BURs & replacements come from the [db exports](https://e621.net/db_exports), with [e621-export-downloader](https://www.npmjs.com/package/e621-export-downloader) and `psql`. The posts export is ~2GB compressed and a lot more uncompressed, it's in the container's temp directory while it's imported.
- Comments, forum posts & topics, sets, flags, takedowns and news updates are crawled through the api, newest first, only using requests polling doesn't need.

Copies are versioned (`change_seq` for posts, `updated_at` for everything else), so an older one never replaces a newer one, and it's fine to restart or run it again.

```sh
docker compose exec ingester bun run backfill status
docker compose exec ingester bun run backfill verify # compare what's stored with e621
docker compose exec ingester bun run backfill reset posts # or all
```

### Status
`/status` has requests, failures, request times, events, feeds and the backfill. `/status.json` has the same data.

### Authorize
`/authorize` is where people make tokens for `identify`, instead of using an api key. They log in with e621's OAuth, then can create, name & remove tokens, up to `MAX_TOKENS_PER_USER` (10). Every token for a user goes through the same authorization. Make an application on e621 with `OAUTH_REDIRECT_URI` (`https://e621.stream/authorize/callback`) as the redirect uri, and set `E621_OAUTH_CLIENT_ID` & `E621_OAUTH_CLIENT_SECRET`. The gateway then needs postgres too, authorizations & token hashes are stored in `oauth_links` and `stream_tokens`.

Logging in only asks for `openid profile`, and the user is rechecked through `/oauth/userinfo`. Private events need `full`, turning them on goes through e621 again, turning them off narrows the token with a refresh. Access tokens only last 15 minutes, they're refreshed when something needs one, one gateway at a time (refresh tokens can only be used once). If e621 rejects the refresh token, the authorization and its tokens are deleted. Unlinking deletes them too, and revokes it on e621.

The refresh tokens aren't encrypted, they're useless without the client secret.

### Admin
`/admin` lists every connected client (name, user, state, subscriptions, ip & when they connected), and can drop connections and ban users. Log in with an e621 username & api key, only the user ids in `ADMIN_USER_IDS` are let in. Logins last `ADMIN_SESSION_HOURS` (12). With oauth set up, there's also a "Log in with e621" button, it only asks for `openid profile` and revokes the token right after.

Dropped clients get `4012` and banned ones `4013`, the clients don't reconnect after either. Bans are by user id, kept in redis until they're lifted, and drop every connection that user has.

### Logs
Each process logs to `logs/<role>-YYYY-MM-DD.log`, and every request to e621 goes to `logs/requests-<role>-YYYY-MM-DD.log`:

```
2026-11-09T18:11:23.126Z GET 200 600ms https://e621.net/forum_posts.json?limit=320&page=1 StrawberryFoxxo
```

Logs older than `LOG_RETENTION_DAYS` (14) are deleted. `LOG_DIR=` turns them off. Api keys are never logged.

### Test Client
`bun run client` connects to the local gateway and logs everything sent & received. It uses `CLIENT_USER`/`CLIENT_KEY`, or the ingester's account, and subscribes to `*` by default.

```sh
bun run client
bun run client post.create "comment.*" --pretty
bun run client --cursor 1794244609663-0
bun run client --url wss://e621.stream/ws
```

### Pages
`pages/<name>.md` becomes `/<name>/`, `pages/index.md` is `/`, and `pages/template.html` is the layout. The favicon is from E621OpenAPI. `bun run build:pages` builds it into `dist-pages/`, and the `Deploy Pages` workflow deploys it with [PagesDeployServer](https://github.com/DonovanDMC/PagesDeployServer) when `pages/` changes.

The reverse proxy sends `/ws`, `/health`, `/stats`, `/info`, `/status`, `/status.json` and `/admin` to the gateway, and everything else to the pages.
