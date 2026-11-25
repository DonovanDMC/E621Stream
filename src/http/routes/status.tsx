import Router from "@yiffy/bun-router";

import { getStatus } from "../Status.ts";
import Status from "../views/Status.tsx";
import { render } from "../Views.ts";

Router.new("/status", "GET")
    .handle(async () => render(<Status data={await getStatus()} />));

Router.new("/status.json", "GET")
    .handle(async () => Response.json(await getStatus()));
