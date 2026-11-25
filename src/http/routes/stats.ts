import Router from "@yiffy/bun-router";

import { latestEvent } from "../../gateway/events.ts";
import { recent } from "../../util/metrics.ts";
import { connectionCount } from "../Status.ts";

const MINUTES = 60;

async function stats(): Promise<Response> {
    const [connections, latest, minutes] = await Promise.all([connectionCount(), latestEvent(), recent("minute", MINUTES)]);
    return Response.json({
        connections,
        events_last_hour: minutes.reduce((total, minute) => total + (minute.counts.events ?? 0), 0),
        last_event_id: latest?.id ?? null,
        last_event_at: latest?.time ?? null,
    });
}

// both, since the old site used /stats
Router.new("/stats", "GET")
    .handle(stats);

Router.new("/stats.json", "GET")
    .handle(stats);
