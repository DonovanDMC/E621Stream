import Router, { Middleware } from "@yiffy/bun-router";
import Debug from "@yiffy/debug";

import Config from "../config/Config.ts";
import HTTPConfig from "../config/HTTPConfig.ts";
import { startLogging } from "../util/FileLog.ts";
import { checkServices } from "../util/util.ts";

import { FlashMiddleware } from "./Flash.ts";
import { HeadersMiddleware } from "./Headers.ts";
import { startOAuthRefresh } from "./OAuth.tsx";
import GenericError from "./views/GenericError.tsx";
import NotFound from "./views/NotFound.tsx";
import { render } from "./Views.ts";

await startLogging("http");
await checkServices();

/**
 * Redirects
 * 302 - Found (method usually becomes GET)
 * 303 - See Other (method becomes GET)
 * 307 - Temporary Redirect (method stays the same)
 * 308 - Permanent Redirect (method stays the same)
 */

Router
    .configure({ trailingSlash: "ignore" })
    // first, so it sees what everything else sends
    .useAll(HeadersMiddleware)
    .useAll(Middleware.ETag)
    .useAll(Middleware.RequestId)
    .useAll(FlashMiddleware)
    .useAll(Middleware.Timing({
        log(durationMs, req) {
            const url = new URL(req.url);
            Debug("http:request", `${req.method} ${url.pathname}${url.search} ${Math.trunc(durationMs)}ms`);
        },
    }));

await Router.load(new URL("./routes", import.meta.url));

const server = Bun.serve({
    hostname: Config.host,
    port: HTTPConfig.port,
    routes: Router.toRoutes(),
    fetch() {
        return render(<NotFound />, 404);
    },
    error(error) {
        try {
            return render(<GenericError title="Internal Server Error" message={`${error.name}: ${error.message}`} />, 500);
        } catch (err) {
            console.error(`Failed to render error page:`);
            console.error(err);
            console.error("Error that triggered error page:");
            console.error(error);
            return new Response("Internal Server Error", { status: 500 });
        }
    },
});

Debug("http", `Listening on http://${server.hostname}:${server.port}`);
if (HTTPConfig.oauthEnabled) startOAuthRefresh();
