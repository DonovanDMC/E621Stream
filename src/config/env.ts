import { z } from "zod";

export const bool = z.stringbool({
    truthy: ["true", "t", "yes", "y", "1"],
    falsy: ["false", "f", "no", "n", "0"],
});

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export const list = <Z extends z.ZodType<unknown, string>>(item: Z) => z.string().transform(v => v.split(",").map(s => s.trim()).filter(Boolean)).pipe(z.array(item));

// names from before the config was split per service, so a renamed setting isn't silently ignored
const RENAMED: Record<string, string> = {
    SESSION_LENGTH: "HTTP_SESSION_LENGTH",
    MAX_TOKENS_PER_USER: "HTTP_MAX_TOKENS_PER_USER",
    E621_OAUTH_CLIENT_ID: "HTTP_OAUTH_CLIENT_ID",
    E621_OAUTH_CLIENT_SECRET: "HTTP_OAUTH_CLIENT_SECRET",
    E621_OAUTH_REDIRECT_URI: "HTTP_OAUTH_REDIRECT_URI",
    WS_IDLE_TIMEOUT: "GATEWAY_IDLE_TIMEOUT",
    WS_AUTH_REQUIRED: "GATEWAY_AUTH_REQUIRED",
    IDENTIFY_TIMEOUT: "GATEWAY_IDENTIFY_TIMEOUT",
    MAX_CONNECTIONS_PER_IP: "GATEWAY_MAX_CONNECTIONS_PER_IP",
    MAX_CONNECTIONS_PER_USER: "GATEWAY_MAX_CONNECTIONS_PER_USER",
    MAX_SUBSCRIPTIONS: "GATEWAY_MAX_SUBSCRIPTIONS",
    AUTH_CACHE_SECONDS: "GATEWAY_AUTH_CACHE_SECONDS",
    SNAPSHOT_CHUNK_SIZE: "GATEWAY_SNAPSHOT_CHUNK_SIZE",
    MAX_SNAPSHOT_IDS: "GATEWAY_MAX_SNAPSHOT_IDS",
    SESSION_RECHECK_INTERVAL: "GATEWAY_SESSION_RECHECK_INTERVAL",
    MAX_CLIENT_MESSAGES_PER_MINUTE: "GATEWAY_MAX_MESSAGES_PER_MINUTE",
    MAX_BUFFERED_BYTES: "GATEWAY_MAX_BUFFERED_BYTES",
    REPLAY_BATCH_SIZE: "GATEWAY_REPLAY_BATCH_SIZE",
    E621_PRIVATE_REQUEST_INTERVAL: "GATEWAY_PRIVATE_REQUEST_INTERVAL",
    E621_PRIVATE_POLL_INTERVAL: "GATEWAY_PRIVATE_POLL_INTERVAL",
    BACKFILL: "INGESTER_BACKFILL",
    DISABLED_SOURCES: "INGESTER_DISABLED_SOURCES",
    POLL_INTERVAL_SCALE: "INGESTER_POLL_INTERVAL_SCALE",
    IDLE_POLL_SCALE: "INGESTER_IDLE_POLL_SCALE",
    LATENCY_ALERT_MS: "INGESTER_LATENCY_ALERT_MS",
    E621_EGRESS_FAMILY: "EGRESS_FAMILY",
    REPLAY_LIMIT: "STREAM_MAX_LENGTH",
};

// z.coerce would convert "" to 0/false/etc
const cleanEnv = Object.fromEntries(Object.entries(Bun.env).filter(([, v]) => v !== ""));

const renamed = Object.keys(RENAMED).filter(name => name in cleanEnv);
if (renamed.length !== 0) throw new Error(`Invalid configuration, these were renamed:\n${renamed.map(name => `  ${name} is now ${RENAMED[name]}`).join("\n")}`);

/** Parses one section's env, label says which in errors */
export function parseEnv<S extends z.ZodObject>(label: string, schema: S): z.output<S> {
    const result = schema.safeParse(cleanEnv);
    if (!result.success) throw new Error(`Invalid ${label} configuration:\n${z.prettifyError(result.error)}`);
    return result.data;
}
