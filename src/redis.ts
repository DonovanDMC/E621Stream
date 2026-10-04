import { RedisClient } from "bun";

import { redisURL } from "./config.ts";

const redis = new RedisClient(redisURL, { autoReconnect: true, maxRetries: 4_294_967_295, enableOfflineQueue: true });
export default redis;
