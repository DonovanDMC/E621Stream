export const METRICS_MINUTE_TTL_SECONDS = 2 * 60 * 60;
export const METRICS_HOUR_TTL_SECONDS = 8 * 24 * 60 * 60;
export const METRICS_FLUSH_MS = 5000;

export const OAUTH_STATE_COOKIE = "_e621stream_oauth";
export const SESSION_COOKIE = "_e621stream_session";
export const FLASH_COOKIE = "_e621stream_flash";
export const MAX_TOKEN_NAME_LENGTH = 50;
export const MAX_OAUTH_PENDING_SECONDS = 600;
export const MAX_OAUTH_ATTEMPTS = 20;
export const BANNED_LEVEL = 10;
export const MAX_BAN_REASON_LENGTH = 500;

export const MESSAGE_LIMIT_MIN = 1;
export const MESSAGE_LIMIT_MAX = 1000;

export const SLOW_MODE_DEFAULT_SCALE = 3;
export const SLOW_MODE_MIN_SCALE = 2;
export const SLOW_MODE_MAX_SCALE = 20;

// seconds, body included. a slow request is given up on and retried rather than holding up the queue
export const E621_REQUEST_TIMEOUT = 10;

export const MAX_FILTER_TAGS = 40;
export const MAX_FILTER_IDs = 1000;

export const GATEWAY_TOKEN_PREFIX = "e6s_";
export const GATEWAY_CLIENT_NAME_LIMIT = 50;
export const GATEWAY_NONCE_LIMIT = 100;
export const GATEWAY_MAX_BACKLOG = 50_000;
