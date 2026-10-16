import Debug from "@yiffy/debug";

import { startGateway } from "./gateway/index.ts";
import { startIngester } from "./ingester/index.ts";
import { startLogging } from "./logs.ts";

const role = Bun.env.ROLE ?? "all";
if (!["all", "ingester", "gateway"].includes(role)) throw new Error(`ROLE must be all, ingester, or gateway, got "${role}"`);

startLogging(role);
Debug("e621stream", `starting as ${role}`);
if (role === "all" || role === "ingester") await startIngester();
if (role === "all" || role === "gateway") startGateway();
