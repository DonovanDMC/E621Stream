import { z } from "zod";

import pkg from "../../package.json";

import { bool, list, parseEnv } from "./env.ts";

async function readTrimmed(path: string | URL): Promise<string | undefined> {
    const file = Bun.file(path);
    return (await file.exists() ? (await file.text()).trim() : undefined);
}

async function resolveVersion(): Promise<string> {
    if (Bun.env.GIT_COMMIT) return Bun.env.GIT_COMMIT;
    // this assumes the code will never run transpiled
    const base = await Bun.file("/.dockerenv").exists() ? "/app" : Bun.fileURLToPath(new URL("../..", import.meta.url));

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

/** Values more than one service uses, service specific ones are in their own config with their own env prefix */
const env = parseEnv("shared", z.object({
    PUBLIC_URL: z.url().default("https://e621.stream"),
    PUBLIC_WS_URL: z.url({ protocol: /^wss?$/ }).default("wss://e621.stream/ws"),
    // client ips come from CF-Connecting-IP/X-Forwarded-For, for the site and the gateway
    TRUST_PROXY: bool.default(false),
    ENCRYPTION_KEY: z.string(),
    ENCRYPTION_SALT: z.string(),
    HMAC_KEY: z.string(),

    REDIS_PREFIX: z.string().default("e621stream:"), // directly appended as-is
    REDIS_URL: z.url({ protocol: /^redis$/ }).default("redis://redis:6379/0"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).default("postgresql://e621stream:@postgres:5432/e621stream"),
    DISCORD_NOTIFICATION_WEBHOOK_URL: z.url().optional(),
    DISCORD_WEBHOOK_BASE: z.url().default("https://discord.com"), // https://github.com/cykreet/alligator

    // every service talks to e621, and they share the rate limit through redis
    E621_BASE_URL: z.url().default("https://e621.net"),
    E621_USER_AGENT: z.string().optional(),
    E621_AUTH_USER: z.string(),
    E621_AUTH_KEY: z.string(),
    E621_REQUEST_INTERVAL: z.coerce.number().int().positive().default(550), // ms
    E621_AUTH_REQUEST_INTERVAL: z.coerce.number().int().positive().default(1000), // ms
    E621_EGRESS_PROXIES: list(z.url()).default([]),
    E621_DIRECT_FALLBACK_ONLY: bool.default(false),

    LOG_DIR: z.string().default("logs"),
    LOG_EVENTS: bool.default(true),
    // the ingester trims the stream, the gateway replays from it
    REPLAY_PERIOD: z.coerce.number().int().nonnegative().default(0), // hours
    REPLAY_LIMIT: z.coerce.number().int().positive().default(2_000_000),
}));

const version = await resolveVersion();
const isDocker = await Bun.file("/.dockerenv").exists();

const Config = {
    version,
    host: isDocker ? "0.0.0.0" : "127.0.0.1",
    publicURL: env.PUBLIC_URL,
    publicWSURL: env.PUBLIC_WS_URL,
    trustProxy: env.TRUST_PROXY,
    encryptionKey: env.ENCRYPTION_KEY,
    encryptionSalt: env.ENCRYPTION_SALT,
    hmacKey: env.HMAC_KEY,

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
    e621EgressProxies: env.E621_EGRESS_PROXIES,
    e621DirectFallbackOnly: env.E621_DIRECT_FALLBACK_ONLY,

    logDir: env.LOG_DIR,
    logEvents: env.LOG_EVENTS,
    replayPeriod: env.REPLAY_PERIOD,
    replayLimit: env.REPLAY_LIMIT,
} as const;

if (Config.e621DirectFallbackOnly && Config.e621EgressProxies.length === 0) {
    console.error(`E621_DIRECT_FALLBACK_ONLY enabled with no egress proxies specified`);
    process.exit(1);
}

export default Config;
