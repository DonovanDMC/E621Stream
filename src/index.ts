import Debug from "@yiffy/debug";

import { startEgress } from "./egress.ts";
import { startGateway } from "./gateway/index.ts";
import { startIngester } from "./ingester/index.ts";
import { startLogging } from "./logs.ts";

const role = Bun.env.ROLE ?? "all";
if (!["all", "ingester", "gateway", "egress"].includes(role)) throw new Error(`ROLE must be all, ingester, gateway, or egress, got "${role}"`);

startLogging(role);
Debug("e621stream", `starting as ${role}`);
if (role === "egress") startEgress();
if (role === "all" || role === "ingester") await startIngester();
if (role === "all" || role === "gateway") startGateway();
