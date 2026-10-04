import Debug from "@yiffy/debug";

import { startIngester } from "./ingester/index.ts";

Debug("e621stream", "starting");
startIngester();
