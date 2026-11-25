import type { AnyPathMiddleware } from "@yiffy/bun-router";

// open to other sites, so browser clients can read them
const PUBLIC_JSON = ["/info", "/health", "/stats", "/stats.json", "/status.json"];
// logged in pages, nothing should keep a copy or index them
const PRIVATE_PREFIXES = ["/admin", "/user"];

const isPrivate = (path: string): boolean => PRIVATE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));

/** CORS for the public json, and caching for everything that doesn't set its own */
export const HeadersMiddleware: AnyPathMiddleware = async (req, server, next) => {
    const res = await next(req, server);
    // copied, some responses (like redirects) can't have their headers changed
    const headers = new Headers(res.headers);
    const path = new URL(req.url).pathname;
    if (PUBLIC_JSON.includes(path)) headers.set("Access-Control-Allow-Origin", "*");
    if (isPrivate(path)) {
        headers.set("Cache-Control", "no-store");
        headers.set("X-Robots-Tag", "noindex");
    // the nav says who's logged in, so pages are checked again every time. the etag means unchanged ones aren't sent again
    } else if (!headers.has("Cache-Control")) {
        headers.set("Cache-Control", "no-cache");
    }
    return new Response(res.body, { headers, status: res.status, statusText: res.statusText });
};
