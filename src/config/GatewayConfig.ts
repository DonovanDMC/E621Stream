import { z } from "zod";

import { bool, parseEnv } from "./env.ts";

// the site shows these in the docs too, so it reads them as well
const env = parseEnv("gateway", z.object({
    GATEWAY_PORT: z.coerce.number().int().positive().default(3000),
    GATEWAY_IDLE_TIMEOUT: z.coerce.number().int().positive().default(120), // seconds
    GATEWAY_AUTH_REQUIRED: bool.default(true),
    GATEWAY_IDENTIFY_TIMEOUT: z.coerce.number().int().positive().default(10_000), // ms
    GATEWAY_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(10),
    GATEWAY_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(10),
    GATEWAY_MAX_SUBSCRIPTIONS: z.coerce.number().int().positive().default(50),
    GATEWAY_MAX_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(60), // the default, admins can change it per user
    GATEWAY_AUTH_CACHE_SECONDS: z.coerce.number().int().positive().default(30 * 60),
    GATEWAY_SESSION_RECHECK_INTERVAL: z.coerce.number().int().positive().default(60_000), // ms
    GATEWAY_SNAPSHOT_CHUNK_SIZE: z.coerce.number().int().positive().default(100),
    GATEWAY_MAX_SNAPSHOT_IDS: z.coerce.number().int().positive().default(1000), // per request
    GATEWAY_MAX_BUFFERED_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024), // 16MB
    GATEWAY_REPLAY_BATCH_SIZE: z.coerce.number().int().positive().default(500),
    GATEWAY_PRIVATE_REQUEST_INTERVAL: z.coerce.number().int().positive().default(1000), // ms
    GATEWAY_PRIVATE_POLL_INTERVAL: z.coerce.number().int().positive().default(60_000), // ms, each user's
}));

const GatewayConfig = {
    port: env.GATEWAY_PORT,
    idleTimeout: env.GATEWAY_IDLE_TIMEOUT,
    authRequired: env.GATEWAY_AUTH_REQUIRED,
    identifyTimeout: env.GATEWAY_IDENTIFY_TIMEOUT,
    maxConnectionsPerIP: env.GATEWAY_MAX_CONNECTIONS_PER_IP,
    maxConnectionsPerUser: env.GATEWAY_MAX_CONNECTIONS_PER_USER,
    maxSubscriptions: env.GATEWAY_MAX_SUBSCRIPTIONS,
    maxMessagesPerMinute: env.GATEWAY_MAX_MESSAGES_PER_MINUTE,
    authCacheSeconds: env.GATEWAY_AUTH_CACHE_SECONDS,
    sessionRecheckInterval: env.GATEWAY_SESSION_RECHECK_INTERVAL,
    snapshotChunkSize: env.GATEWAY_SNAPSHOT_CHUNK_SIZE,
    maxSnapshotIDs: env.GATEWAY_MAX_SNAPSHOT_IDS,
    maxBufferedBytes: env.GATEWAY_MAX_BUFFERED_BYTES,
    replayBatchSize: env.GATEWAY_REPLAY_BATCH_SIZE,
    privateRequestInterval: env.GATEWAY_PRIVATE_REQUEST_INTERVAL,
    privatePollInterval: env.GATEWAY_PRIVATE_POLL_INTERVAL,
} as const;

export default GatewayConfig;
