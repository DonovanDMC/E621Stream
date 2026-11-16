// every setting, read from env once at startup. .env.example has the same list
// unset or empty env vars get the default

function int(name: string, def: number): number {
    const value = Bun.env[name];
    if (value === undefined || value === "") return def;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a number, got "${value}"`);
    return parsed;
}

function bool(name: string, def: boolean): boolean {
    const value = Bun.env[name];
    if (value === undefined || value === "") return def;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

// comma separated, blanks dropped
function list(name: string): Array<string> {
    return (Bun.env[name] ?? "").split(",").map(v => v.trim()).filter(Boolean);
}

// set at build time by the Dockerfile, shown on the docs & status pages
export const gitCommit = Bun.env.GIT_COMMIT?.trim() ? Bun.env.GIT_COMMIT.trim() : "unknown";
export const repositoryURL = "https://github.com/DonovanDMC/E621Stream";

// redis is how the ingester and gateways talk to each other. every key is under the prefix
export const redisURL = Bun.env.REDIS_URL ?? "redis://redis:6379";
export const redisPrefix = Bun.env.REDIS_PREFIX ?? "e621stream";
// the redis stream every event goes on, entries are { t: type, ts: time, d: json data, r?: recovery id }
export const streamKey = `${redisPrefix}:events`;
// hash of feed name (or feed:field) -> where that feed got to, so a restart carries on instead of starting over
export const cursorKey = `${redisPrefix}:cursors`;
// hash of feed name -> FeedHealth json, for the status page
export const feedsKey = `${redisPrefix}:feeds`;
// hash of gateway id -> how many connections it has, fields expire so dead gateways drop off
export const clientsKey = `${redisPrefix}:clients`;
// hash of gateway id -> json list of its connections, for the admin page
export const clientListKey = `${redisPrefix}:client_list`;
// hash of e621 user id -> Ban json
export const bansKey = `${redisPrefix}:bans`;
// pub/sub channel for admin actions (drop/ban), every gateway listens
export const adminChannel = `${redisPrefix}:admin`;
// "true" while the ingester is polling slower because nobody's connected
export const idleKey = `${redisPrefix}:ingester:idle`;
// DataCounts json, how many snapshots are stored per resource
export const dataKey = `${redisPrefix}:data`;
// the current (or last) Recovery json, there's only ever one
export const recoveryKey = `${redisPrefix}:recovery`;
// postgres holds snapshots (the last known state of records) and the backfill/oauth tables
export const databaseURL = Bun.env.DATABASE_URL ?? "postgres://e621stream:e621stream@postgres:5432/e621stream";

// e621
// also the only host fetch requests get logged/routed for, and the only host the egress proxy allows
export const e621BaseURL = Bun.env.E621_BASE_URL ?? "https://e621.net";
export const e621UserAgent = Bun.env.E621_USER_AGENT ?? "E621Stream/0.0.0 (by Donovan_DMC; +https://e621.stream)";
// everything this account can see gets sent out publicly, don't use a privileged account
export const e621AuthUser = Bun.env.E621_AUTH_USER?.trim();
export const e621AuthKey = Bun.env.E621_AUTH_KEY?.trim();
// e621's limit is 2/s. these are the gap between request starts for each queue (see RequestQueue in e621.ts)
// ingester feeds & the backfill
export const e621RequestIntervalMS = int("E621_REQUEST_INTERVAL_MS", 550);
// checking credentials people connect with, and oauth
export const e621AuthRequestIntervalMS = int("E621_AUTH_REQUEST_INTERVAL_MS", 1000);
// polling private events (dmails, private sets) with each user's credentials
export const e621PrivateRequestIntervalMS = int("E621_PRIVATE_REQUEST_INTERVAL_MS", 1000);
// how often each user's private events are polled
export const privatePollIntervalMS = int("PRIVATE_POLL_INTERVAL_MS", 60_000);
// fill the snapshots table from e621's db exports & crawling, so update events have something to diff against
export const backfillEnabled = bool("BACKFILL", true);
// feed names (see FEEDS/UPDATES) that aren't polled at all
export const disabledSources = new Set(list("DISABLED_SOURCES"));
// urls of egress proxies (ROLE=egress) to spread requests across
export const egressProxies = list("E621_EGRESS_PROXIES");
// whether an egress proxy connects to e621 over ipv4 or ipv6
export const egressFamily = int("EGRESS_FAMILY", 6) === 4 ? 4 : 6;
// multiplies every feed's poll interval, for running slower in dev
export const pollIntervalScale = int("POLL_INTERVAL_SCALE", 1);
// how many times slower feeds are polled while nobody's connected and the backfill is still going
export const idlePollScale = int("IDLE_POLL_SCALE", 10);

// daily log files, empty LOG_DIR turns them off
export const logDir = Bun.env.LOG_DIR ?? "logs";
export const logRetentionDays = int("LOG_RETENTION_DAYS", 14);
// every event the gateway sends out, one line each. it's the full event, so it gets big
export const logEvents = bool("LOG_EVENTS", true);

// stream retention, events older than this (or past this many) are trimmed and can't be replayed
export const retentionHours = int("RETENTION_HOURS", 24);
export const maxStreamLength = int("MAX_STREAM_LENGTH", 2_000_000);

// gateway
// also the egress proxy's port
export const port = int("PORT", 3000);
// what /info says to connect to
export const publicURL = Bun.env.PUBLIC_URL ?? "wss://e621.stream/ws";
// whether clients have to send e621 credentials or a token to connect
export const authRequired = bool("AUTH_REQUIRED", true);
// use cf-connecting-ip / x-forwarded-for / x-forwarded-proto, only when behind a proxy that sets them
export const trustProxy = bool("TRUST_PROXY", false);
// connections that don't identify within this get closed
export const identifyTimeoutMS = int("IDENTIFY_TIMEOUT_MS", 10_000);
// 0 for no limit. per gateway, not across all of them
export const maxConnectionsPerIP = int("MAX_CONNECTIONS_PER_IP", 10);
export const maxConnectionsPerUser = int("MAX_CONNECTIONS_PER_USER", 5);
// how long a credentials check with e621 is trusted, also how often oauth links are rechecked
export const authCacheSeconds = int("AUTH_CACHE_SECONDS", 30 * 60);

// oauth, /authorize is turned off unless the client id & secret are set
export const oauthClientId = Bun.env.E621_OAUTH_CLIENT_ID?.trim();
export const oauthClientSecret = Bun.env.E621_OAUTH_CLIENT_SECRET?.trim();
export const oauthEnabled = Boolean(oauthClientId && oauthClientSecret);
export const oauthRedirectURI = Bun.env.OAUTH_REDIRECT_URI ?? "https://e621.stream/authorize/callback";
// the token page, on the same host as the redirect uri
export const authorizeURL = new URL("/authorize", oauthRedirectURI).href;
// stream tokens each linked user can make
export const maxTokensPerUser = int("MAX_TOKENS_PER_USER", 10);

// nobody can log in to /admin if this is empty
export const adminUserIDs = new Set(list("ADMIN_USER_IDS").map(Number).filter(id => Number.isSafeInteger(id) && id > 0));
export const adminSessionHours = int("ADMIN_SESSION_HOURS", 12);
// per connection
export const maxSubscriptions = int("MAX_SUBSCRIPTIONS", 50);
// ids in one snapshot request
export const maxSnapshotIds = int("MAX_SNAPSHOT_IDS", 1000);
// big snapshot requests are answered over several messages of this many
export const snapshotChunkSize = int("SNAPSHOT_CHUNK_SIZE", 100);
// messages a client can send in a rolling minute before it's closed
export const maxClientMessagesPerMinute = int("MAX_CLIENT_MESSAGES_PER_MINUTE", 60);
// for privileged+ (level 30+) users
export const maxPrivilegedMessagesPerMinute = int("MAX_PRIVILEGED_MESSAGES_PER_MINUTE", 120);
// a client with more than this waiting to be sent gets closed as too slow. replays & snapshots pause at half
export const maxBufferedBytes = int("MAX_BUFFERED_BYTES", 16 * 1024 * 1024);
// stream entries read per XRANGE while replaying
export const replayBatchSize = int("REPLAY_BATCH_SIZE", 500);
