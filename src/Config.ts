import { z } from "zod";

import pkg from "../package.json";

async function readTrimmed(path: string | URL): Promise<string | undefined> {
    const file = Bun.file(path);
    return (await file.exists() ? (await file.text()).trim() : undefined);
}

async function resolveVersion(): Promise<string> {
    if (Bun.env.GIT_COMMIT) return Bun.env.GIT_COMMIT;
    // this assumes the code will never run transpiled
    const base = await Bun.file("/.dockerenv").exists() ? "/app" : Bun.fileURLToPath(new URL("..", import.meta.url));

    const files = ["COMMIT", "REVISION"];
    for (const file of files) {
        const content = await readTrimmed(`${base}/${file}`);
        if (content) return content;
    }

    const head = await readTrimmed(`${base}/.git/HEAD`);
    if (head) {
        if (head.startsWith("ref: ")) {
            const ref = await readTrimmed(`${base}/.git/${head.slice(5)}`);
            if (ref) return ref;
        } else return head;
    }

    return pkg.version;
}

const bool = z.stringbool({
    truthy: ["true", "t", "yes", "y", "1"],
    falsy: ["false", "f", "no", "n", "0"],
});

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const list = <Z extends z.ZodType<unknown, string>>(item: Z) => z.string().transform(v => v.split(",").map(s => s.trim()).filter(Boolean)).pipe(z.array(item));

const schema = z.object({
    HTTP_PORT: z.coerce.number().int().positive().default(3000),
    GATEWAY_PORT: z.coerce.number().int().positive().default(3000),
    EGRESS_PORT: z.coerce.number().int().positive().default(3000),
    WS_IDLE_TIMEOUT: z.coerce.number().int().positive().default(120), // seconds
    PUBLIC_URL: z.url().default("https://e621.stream"),
    PUBLIC_WS_URL: z.url({ protocol: /^wss?$/ }).default("wss://e621.stream/ws"),
    WS_AUTH_REQUIRED: bool.default(true),
    TRUST_PROXY: bool.default(false),
    SESSION_LENGTH: z.coerce.number().int().positive().default(24), // hours, how long logins on the site last
    ENCRYPTION_KEY: z.string(),
    ENCRYPTION_SALT: z.string(),
    HMAC_KEY: z.string(),

    IDENTIFY_TIMEOUT: z.coerce.number().int().positive().default(10_000), // ms
    MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(10),
    MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(10),
    MAX_SUBSCRIPTIONS: z.coerce.number().int().positive().default(50),
    AUTH_CACHE_SECONDS: z.coerce.number().int().positive().default(30 * 60),

    REDIS_PREFIX: z.string().default("e621stream:"), // directly appended as-is
    REDIS_URL: z.url({ protocol: /^redis$/ }).default("redis://redis:6379/0"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).default("postgresql://e621stream:@postgres:5432/e621stream"),
    DISCORD_NOTIFICATION_WEBHOOK_URL: z.url().optional(),
    DISCORD_WEBHOOK_BASE: z.url().default("https://discord.com"), // https://github.com/cykreet/alligator

    E621_BASE_URL: z.url().default("https://e621.net"),
    E621_USER_AGENT: z.string().optional(),
    E621_AUTH_USER: z.string(),
    E621_AUTH_KEY: z.string(),
    E621_REQUEST_INTERVAL: z.coerce.number().int().positive().default(550), // ms
    E621_AUTH_REQUEST_INTERVAL: z.coerce.number().int().positive().default(1000), // ms
    E621_PRIVATE_REQUEST_INTERVAL: z.coerce.number().int().positive().default(1000), // ms
    E621_PRIVATE_POLL_INTERVAL: z.coerce.number().int().positive().default(60_000), // ms
    E621_EGRESS_PROXIES: list(z.url()).default([]),
    E621_EGRESS_FAMILY: z.coerce.number().pipe(z.literal([4, 6])).default(4),
    E621_DIRECT_FALLBACK_ONLY: bool.default(false),

    E621_OAUTH_CLIENT_ID: z.string().optional(),
    E621_OAUTH_CLIENT_SECRET: z.string().optional(),
    E621_OAUTH_REDIRECT_URI: z.string().optional(),
    MAX_TOKENS_PER_USER: z.coerce.number().int().positive().default(10),

    BACKFILL: bool.default(false),
    DISABLED_SOURCES: list(z.string()).default([]),

    LATENCY_ALERT_MS: z.coerce.number().int().positive().default(2000), // median over 5 minutes
    POLL_INTERVAL_SCALE: z.coerce.number().int().positive().default(1), // multiplier
    IDLE_POLL_SCALE: z.coerce.number().int().positive().default(10), // multiplier
    LOG_DIR: z.string().default("logs"),
    LOG_EVENTS: bool.default(true),
    REPLAY_PERIOD: z.coerce.number().int().positive().default(0), // hours
    REPLAY_LIMIT: z.coerce.number().int().positive().default(2_000_000),
    SNAPSHOT_CHUNK_SIZE: z.coerce.number().int().positive().default(1000),
    MAX_SNAPSHOT_IDS: z.coerce.number().int().positive().default(1000), // per request
    SESSION_RECHECK_INTERVAL: z.coerce.number().int().positive().default(60_000),
    MAX_CLIENT_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(60),
    MAX_BUFFERED_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024), // 16MB
    REPLAY_BATCH_SIZE: z.coerce.number().int().positive().default(500),
});

// z.coerce would convert "" to 0/false/etc
const cleanEnv = Object.fromEntries(Object.entries(Bun.env).filter(([, v]) => v !== ""));

const result = schema.safeParse(cleanEnv);
if (!result.success) throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
const env = result.data;

const version = await resolveVersion();
const isDocker = await Bun.file("/.dockerenv").exists();

const Config = {
    version,
    host: isDocker ? "0.0.0.0" : "127.0.0.1",
    httpPort: env.HTTP_PORT,
    gatewayPort: env.GATEWAY_PORT,
    egressPort: env.EGRESS_PORT,
    wsIdleTimeout: env.WS_IDLE_TIMEOUT,
    publicURL: env.PUBLIC_URL,
    publicWSURL: env.PUBLIC_WS_URL,
    wsAuthRequired: env.WS_AUTH_REQUIRED,
    trustProxy: env.TRUST_PROXY,
    sessionLength: env.SESSION_LENGTH,
    encryptionKey: env.ENCRYPTION_KEY,
    encryptionSalt: env.ENCRYPTION_SALT,
    hmacKey: env.HMAC_KEY,

    identifyTimeout: env.IDENTIFY_TIMEOUT,
    maxConnectionsPerIP: env.MAX_CONNECTIONS_PER_IP,
    maxConnectionsPerUser: env.MAX_CONNECTIONS_PER_USER,
    maxSubscriptions: env.MAX_SUBSCRIPTIONS,
    authCacheSeconds: env.AUTH_CACHE_SECONDS,

    redisURL: env.REDIS_URL,
    redisPrefix: env.REDIS_PREFIX,
    databaseURL: env.DATABASE_URL,
    discordNotificationWebhookURL: env.DISCORD_NOTIFICATION_WEBHOOK_URL,
    discordWebhookBase: env.DISCORD_WEBHOOK_BASE,

    e621BaseURL: env.E621_BASE_URL,
    e621UserAgent: env.E621_USER_AGENT ?? `E621Stream/${version} (by Donovan_DMC; +${env.PUBLIC_URL})`,
    e621AuthUser: env.E621_AUTH_USER,
    e621AuthKey: env.E621_AUTH_KEY,
    e621RequestInterval: env.E621_REQUEST_INTERVAL,
    e621AuthRequestInterval: env.E621_AUTH_REQUEST_INTERVAL,
    e621PrivateRequestInterval: env.E621_PRIVATE_REQUEST_INTERVAL,
    e621PrivatePollInterval: env.E621_PRIVATE_POLL_INTERVAL,
    e621EgressProxies: env.E621_EGRESS_PROXIES,
    e621EgressFamily: env.E621_EGRESS_FAMILY,
    e621DirectFallbackOnly: env.E621_DIRECT_FALLBACK_ONLY,

    e621OAuthEnabled: env.E621_OAUTH_CLIENT_ID && env.E621_OAUTH_CLIENT_SECRET,
    e621OAuthClientID: env.E621_OAUTH_CLIENT_ID,
    e621OAuthClientSecret: env.E621_OAUTH_CLIENT_SECRET,
    e621OAuthRedirectURI: env.E621_OAUTH_REDIRECT_URI ?? new URL("/user/login/oauth/callback", env.PUBLIC_URL).href,
    maxTokensPerUser: env.MAX_TOKENS_PER_USER,

    backfillEnabled: env.BACKFILL,
    disabledSources: env.DISABLED_SOURCES,

    latencyAlertMS: env.LATENCY_ALERT_MS,
    pollIntervalScale: env.POLL_INTERVAL_SCALE,
    idlePollScale: env.IDLE_POLL_SCALE,
    logDir: env.LOG_DIR,
    logEvents: env.LOG_EVENTS,
    replayPeriod: env.REPLAY_PERIOD,
    replayLimit: env.REPLAY_LIMIT,
    snapshotChunkSize: env.SNAPSHOT_CHUNK_SIZE,
    maxSnapshotIDs: env.MAX_SNAPSHOT_IDS,
    sessionRecheckInterval: env.SESSION_RECHECK_INTERVAL,
    maxClientMessagesPerMinute: env.MAX_CLIENT_MESSAGES_PER_MINUTE,
    maxBufferedBytes: env.MAX_BUFFERED_BYTES,
    replayBatchSize: env.REPLAY_BATCH_SIZE,
} as const;

if (Config.e621DirectFallbackOnly && Config.e621EgressProxies.length === 0) {
    console.error(`E621_DIRECT_FALLBACK_ONLY enabled with no egress proxies specified`);
    process.exit(1);
}

export default Config;
