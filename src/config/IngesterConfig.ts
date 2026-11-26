import { z } from "zod";

import { bool, list, parseEnv } from "./env.ts";

const env = parseEnv("ingester", z.object({
    INGESTER_BACKFILL: bool.default(false), // store everything from before the feeds started
    INGESTER_DISABLED_SOURCES: list(z.string()).default([]),
    INGESTER_POLL_INTERVAL_SCALE: z.coerce.number().int().positive().default(1), // multiplier
    INGESTER_IDLE_POLL_SCALE: z.coerce.number().int().positive().default(10), // multiplier
    INGESTER_LATENCY_ALERT_MS: z.coerce.number().int().positive().default(2000), // median over 5 minutes
}));

const IngesterConfig = {
    backfillEnabled: env.INGESTER_BACKFILL,
    disabledSources: env.INGESTER_DISABLED_SOURCES,
    pollIntervalScale: env.INGESTER_POLL_INTERVAL_SCALE,
    idlePollScale: env.INGESTER_IDLE_POLL_SCALE,
    latencyAlertMS: env.INGESTER_LATENCY_ALERT_MS,
} as const;

export default IngesterConfig;
