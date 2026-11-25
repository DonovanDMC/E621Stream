import DB from "../db/DB.ts";
import Redis from "../db/Redis.ts";

import { check } from "./util.ts";

export async function servicesUp(ms = 5000, exit = true): Promise<boolean> {
    const redis = await check("redis", () => Redis.ping(), ms);
    const postgres = await check("postgres", () => DB`SELECT 1`, ms);
    let ok = true;
    if (!redis.ok) {
        console.error(`Redis timed out after ${ms}ms`);
        ok = false;
    }
    if (!postgres.ok) {
        console.error(`Postgres timed out after ${ms}ms`);
        ok = false;
    }

    if (!ok && exit) process.exit(1);
    return ok;
}
