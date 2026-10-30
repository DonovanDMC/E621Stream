import { describe, expect, test } from "bun:test";

import { pickRoute, type Route } from "../src/logs.ts";

const routes = (): Array<Route> => [
    { name: "direct", proxy: null, inFlight: 0, downUntil: 0 },
    { name: "egress-1", proxy: "http://egress-1:8080", inFlight: 0, downUntil: 0 },
    { name: "egress-2", proxy: "http://egress-2:8080", inFlight: 0, downUntil: 0 },
];

describe("routes", () => {
    test("go through proxies, even when they're busier than direct", () => {
        const all = routes();
        all[1]!.inFlight = 3;
        all[2]!.inFlight = 3;
        expect(pickRoute(all, 0).name).not.toBe("direct");
    });

    test("pick the proxy with the least in flight", () => {
        const all = routes();
        all[1]!.inFlight = 1;
        expect(pickRoute(all, 0).name).toBe("egress-2");
    });

    test("take turns between equally busy proxies", () => {
        const all = routes();
        expect([0, 1, 2, 3].map(turn => pickRoute(all, turn).name)).toEqual(["egress-1", "egress-2", "egress-1", "egress-2"]);
    });

    test("skip a proxy that just failed, and go direct when none are left", () => {
        const all = routes();
        all[1]!.downUntil = 2000;
        expect(pickRoute(all, 0, 1000).name).toBe("egress-2");
        all[2]!.downUntil = 2000;
        expect(pickRoute(all, 0, 1000).name).toBe("direct");
        expect(pickRoute(all, 0, 3000).name).toBe("egress-1");
    });

    test("go direct when there are no proxies", () => {
        expect(pickRoute([routes()[0]!], 0).name).toBe("direct");
    });
});
