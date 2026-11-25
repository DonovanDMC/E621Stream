// Gives the tests a fresh database & redis db. Run them with `bun run test`, which uses the tests compose service.
import { SQL } from "bun";

const url = new URL(Bun.env.DATABASE_URL ?? "postgres://localhost");
const name = url.pathname.slice(1);
// everything in these is wiped
if (!name.endsWith("_test") || !Bun.env.REDIS_PREFIX?.includes("test")) {
    throw new Error("the tests wipe the database and redis, so they only run against a database ending in _test with a test REDIS_PREFIX. use bun run test");
}

const admin = new SQL({ url: Object.assign(new URL(url), { pathname: "/postgres" }).href, max: 1 });
await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE "${name}"`);
await admin.close();

const db = new SQL({ url: url.href, max: 1 });
// psql meta commands from pg_dump
const schema = (await Bun.file(`${import.meta.dir}/../db/schema.sql`).text()).replaceAll(/^\\.*$/gm, "");
await db.unsafe(schema);
await db.close();

const redis = new Bun.RedisClient(Bun.env.REDIS_URL);
await redis.send("FLUSHDB", []);
redis.close();
