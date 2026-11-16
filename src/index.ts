// entry point. one image runs every part, ROLE picks which:
//  - ingester: polls e621, works out what changed, and puts events on the redis stream
//  - gateway: the http/websocket server, reads the stream and sends events to clients
//  - egress: a CONNECT proxy so e621 requests can go out from another ip (see egress.ts)
//  - all: ingester & gateway in one process, for running locally
import Debug from "@yiffy/debug";

import { startEgress } from "./egress.ts";
import { startGateway } from "./gateway/index.ts";
import { startIngester } from "./ingester/index.ts";
import { startLogging } from "./logs.ts";

const role = Bun.env.ROLE ?? "all";
if (!["all", "ingester", "gateway", "egress"].includes(role)) throw new Error(`ROLE must be all, ingester, gateway, or egress, got "${role}"`);

// has to go first, it wraps fetch & stdout
startLogging(role);
Debug("e621stream", `starting as ${role}`);
if (role === "egress") startEgress();
if (role === "all" || role === "ingester") await startIngester();
if (role === "all" || role === "gateway") startGateway();
