import Config from "../Config.ts";
import Redis from "../db/Redis.ts";

export interface Route {
    // a proxy that failed to connect is skipped until then
    downUntil: number;
    // whether the last request through it failed, null until one is made
    failing: boolean | null;
    inFlight: number;
    // the proxy's hostname up to the first dot, for logs & the status page
    name: string;
    proxy: string | null;
}

export const ROUTES: Array<Route> = [
    { name: "direct", proxy: null, inFlight: 0, downUntil: 0, failing: null },
    ...Config.e621EgressProxies.map(proxy => ({ name: new URL(proxy).hostname.split(".")[0]!, proxy, inFlight: 0, downUntil: 0, failing: null })),
];
export const ROUTE_DOWN_MS = 30_000;

export function pickRoute(routes: Array<Route>, turn: number, now = Date.now()): Route {
    const proxies = routes.filter(route => (!Config.e621DirectFallbackOnly || route.proxy !== null) && route.downUntil <= now);
    if (Config.e621DirectFallbackOnly && proxies.length === 0) return routes.find(route => route.proxy !== null)!;
    const least = Math.min(...proxies.map(route => route.inFlight));
    const free = proxies.filter(route => route.inFlight === least);
    return free[turn % free.length]!;
}

const routesKey = `${Config.redisPrefix}routes`;

export interface RouteState {
    failing: boolean;
    since: string; // ISO timestamp
}

/** Stored when it changes, so the status page can show which routes are failing right now */
export function reportRoute(service: string, route: Route, failing: boolean): void {
    if (route.failing === failing) return;
    route.failing = failing;
    const state: RouteState = { failing, since: new Date().toISOString() };
    void Redis.hset(routesKey, `${service}:${route.name}`, JSON.stringify(state)).catch(() => null);
}

/** Keyed by service then route */
export async function getRouteStates(): Promise<Record<string, RouteState>> {
    const stored = await Redis.hgetall(routesKey);
    return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, JSON.parse(value) as RouteState]));
}
