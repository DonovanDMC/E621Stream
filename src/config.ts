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

function list(name: string): Array<string> {
    return (Bun.env[name] ?? "").split(",").map(v => v.trim()).filter(Boolean);
}

export const redisURL = Bun.env.REDIS_URL ?? "redis://redis:6379";
export const redisPrefix = Bun.env.REDIS_PREFIX ?? "e621stream";
export const streamKey = `${redisPrefix}:events`;
export const cursorKey = `${redisPrefix}:cursors`;
export const feedsKey = `${redisPrefix}:feeds`;
export const clientsKey = `${redisPrefix}:clients`;
export const idleKey = `${redisPrefix}:ingester:idle`;
export const dataKey = `${redisPrefix}:data`;
export const databaseURL = Bun.env.DATABASE_URL ?? "postgres://e621stream:e621stream@postgres:5432/e621stream";

// e621
export const e621BaseURL = Bun.env.E621_BASE_URL ?? "https://e621.net";
export const e621UserAgent = Bun.env.E621_USER_AGENT ?? "E621Stream/0.0.0 (by Donovan_DMC; +https://e621.stream)";
// everything this account can see gets sent out publicly, don't use a privileged account
export const e621AuthUser = Bun.env.E621_AUTH_USER?.trim();
export const e621AuthKey = Bun.env.E621_AUTH_KEY?.trim();
// e621's limit is 2/s
export const e621RequestIntervalMS = int("E621_REQUEST_INTERVAL_MS", 550);
export const e621AuthRequestIntervalMS = int("E621_AUTH_REQUEST_INTERVAL_MS", 1000);
export const e621PrivateRequestIntervalMS = int("E621_PRIVATE_REQUEST_INTERVAL_MS", 1000);
export const privatePollIntervalMS = int("PRIVATE_POLL_INTERVAL_MS", 60_000);
export const backfillEnabled = bool("BACKFILL", true);
export const disabledSources = new Set(list("DISABLED_SOURCES"));
export const pollIntervalScale = int("POLL_INTERVAL_SCALE", 1);
export const idlePollScale = int("IDLE_POLL_SCALE", 10);

export const logDir = Bun.env.LOG_DIR ?? "logs";
export const logRetentionDays = int("LOG_RETENTION_DAYS", 14);

// stream retention
export const retentionHours = int("RETENTION_HOURS", 24);
export const maxStreamLength = int("MAX_STREAM_LENGTH", 2_000_000);

// gateway
export const port = int("PORT", 3000);
export const publicURL = Bun.env.PUBLIC_URL ?? "wss://e621.stream/ws";
export const authRequired = bool("AUTH_REQUIRED", true);
export const trustProxy = bool("TRUST_PROXY", false);
export const identifyTimeoutMS = int("IDENTIFY_TIMEOUT_MS", 10_000);
export const maxConnectionsPerIP = int("MAX_CONNECTIONS_PER_IP", 10);
export const maxConnectionsPerUser = int("MAX_CONNECTIONS_PER_USER", 5);
export const authCacheSeconds = int("AUTH_CACHE_SECONDS", 30 * 60);
export const maxSubscriptions = int("MAX_SUBSCRIPTIONS", 50);
export const maxClientMessagesPerMinute = int("MAX_CLIENT_MESSAGES_PER_MINUTE", 60);
export const maxBufferedBytes = int("MAX_BUFFERED_BYTES", 16 * 1024 * 1024);
export const replayBatchSize = int("REPLAY_BATCH_SIZE", 500);
