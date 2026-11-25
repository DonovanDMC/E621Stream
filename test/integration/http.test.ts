import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { EVENT_TYPES } from "../../src/gateway/events.ts";
import { STORED_RESOURCES } from "../../src/ingester/sources.ts";
import { reset, startService, stopService } from "../helpers.ts";

const PORT = 4200, URL = `http://127.0.0.1:${PORT}`;

let server: Bun.Subprocess | undefined;
beforeAll(async () => {
    await reset();
    server = await startService("src/http/index.tsx", URL, { HTTP_PORT: String(PORT) });
});
afterAll(async () => stopService(server));

const get = async (path: string): Promise<Response> => fetch(`${URL}${path}`, { redirect: "manual" });

describe("json", () => {
    test("/health", async () => {
        const res = await get("/health");
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, last_id: null, redis: { status: "up" }, postgres: { status: "up" } });
    });

    test("/info", async () => {
        const res = await get("/info");
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(await res.json()).toMatchObject({ name: "E621Stream", protocol_version: 2, websocket_url: Bun.env.PUBLIC_WS_URL, events: EVENT_TYPES, snapshot_resources: STORED_RESOURCES });
    });

    for (const path of ["/stats", "/status.json"]) {
        test(path, async () => {
            const res = await get(path);
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toContain("application/json");
        });
    }
});

describe("pages", () => {
    for (const path of ["/", "/subscriptions", "/events", "/replaying", "/snapshots", "/compression", "/close-codes", "/clients", "/status"]) {
        test(path, async () => {
            const res = await get(path);
            expect(res.status).toBe(200);
            expect(res.headers.get("cache-control")).toBe("no-cache");
            expect(await res.text()).toContain("</html>");
        });
    }

    test("unknown pages 404", async () => {
        expect((await get("/nope")).status).toBe(404);
    });
});

describe("logged in pages", () => {
    for (const path of ["/user", "/admin", "/admin/database"]) {
        test(`${path} sends you to log in, and isn't cached`, async () => {
            const res = await get(path);
            expect(res.status).toBeGreaterThanOrEqual(300);
            expect(res.status).toBeLessThan(400);
            expect(res.headers.get("cache-control")).toBe("no-store");
        });
    }
});
