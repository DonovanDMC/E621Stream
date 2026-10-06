function int(name: string, def: number): number {
    const value = Bun.env[name];
    if (value === undefined || value === "") return def;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a number, got "${value}"`);
    return parsed;
}

function list(name: string): Array<string> {
    return (Bun.env[name] ?? "").split(",").map(v => v.trim()).filter(Boolean);
}

export const redisURL = Bun.env.REDIS_URL ?? "redis://redis:6379";
export const redisPrefix = Bun.env.REDIS_PREFIX ?? "e621stream";
export const streamKey = `${redisPrefix}:events`;
export const cursorKey = `${redisPrefix}:cursors`;

// e621
export const e621BaseURL = Bun.env.E621_BASE_URL ?? "https://e621.net";
export const e621UserAgent = Bun.env.E621_USER_AGENT ?? "E621Stream/0.0.0 (by Donovan_DMC; +https://e621.stream)";
// everything this account can see gets sent out publicly, don't use a privileged account
export const e621AuthUser = Bun.env.E621_AUTH_USER?.trim();
export const e621AuthKey = Bun.env.E621_AUTH_KEY?.trim();
// e621's limit is 2/s
export const e621RequestIntervalMS = int("E621_REQUEST_INTERVAL_MS", 550);
export const disabledSources = new Set(list("DISABLED_SOURCES"));
export const pollIntervalScale = int("POLL_INTERVAL_SCALE", 1);

// stream retention
export const retentionHours = int("RETENTION_HOURS", 24);
export const maxStreamLength = int("MAX_STREAM_LENGTH", 2_000_000);
export const postSnapshotTTLSeconds = int("POST_SNAPSHOT_TTL_SECONDS", 7 * 24 * 60 * 60);
// comments, forum posts/topics and tag requests, longer since they change less often but can be edited much later
export const updateSnapshotTTLSeconds = int("UPDATE_SNAPSHOT_TTL_SECONDS", 30 * 24 * 60 * 60);
