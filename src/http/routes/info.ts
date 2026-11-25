import Router from "@yiffy/bun-router";

import Config from "../../Config.ts";
import DB from "../../db/DB.ts";
import Redis from "../../db/Redis.ts";
import { COMPRESSION_TYPES } from "../../gateway/compression.ts";
import { EVENT_TYPES, latestEvent, PRIVATE_EVENT_TYPES } from "../../gateway/events.ts";
import { PROTOCOL_VERSION } from "../../gateway/protocol.ts";
import { STORED_RESOURCES } from "../../ingester/sources.ts";

async function time(func: () => Promise<unknown>): Promise<number> { // ms
    const start = process.hrtime.bigint();
    await func();
    return Number((process.hrtime.bigint() - start) / 1_000_000n /* nanoseconds */);
}

Router.new("/info", "GET")
    .handle(() => {
        return Response.json({
            name: "E621Stream",
            version: Config.version,
            protocol_version: PROTOCOL_VERSION,
            websocket_url: Config.publicWSURL,
            websocket_auth_required: Config.wsAuthRequired,
            compression: COMPRESSION_TYPES,
            events: EVENT_TYPES,
            private_events: PRIVATE_EVENT_TYPES,
            snapshot_resources: STORED_RESOURCES,
        });
    })
    .new("/health", "GET")
    .handle(async () => {
        const redis = await time(() => Redis.ping()).catch(() => null);
        const postgres = await time(() => DB`SELECT 1`).catch(() => null);
        const latest = redis === null ? null : await latestEvent().catch(() => null);
        // 503 so health checks see it, the body still says which one is down
        return Response.json({
            ok: redis !== null && postgres !== null,
            last_id: latest?.id ?? null,
            last_event_at: latest?.time ?? null,
            redis: {
                status: redis === null ? "down" : "up",
                ping: redis,
            },
            postgres: {
                status: postgres === null ? "down" : "up",
                ping: postgres,
            },
        }, redis === null || postgres === null ? 503 : 200);
    });
