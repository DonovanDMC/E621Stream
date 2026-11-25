import { beforeEach, describe, expect, test } from "bun:test";

import Redis, { parseEntry, type StreamEntry } from "../../src/db/Redis.ts";
import { streamKey } from "../../src/gateway/events.ts";
import { getSnapshot, saveSnapshots } from "../../src/gateway/snapshots.ts";
import { UpdateFeed, UPDATES, type UpdateSource } from "../../src/ingester/updates.ts";
import { reset } from "../helpers.ts";

beforeEach(reset);

interface Sent { context?: Record<string, unknown>; data: Record<string, unknown>; type: string }
const events = async (): Promise<Array<Sent>> => (await Redis.send("XRANGE", [streamKey, "-", "+"]) as Array<StreamEntry>).map(parseEntry) as never;
const at = (minutes: number): string => new Date(Date.now() - (minutes * 60_000)).toISOString();

// the real source, reading from a list instead of e621
function feed(name: string, list: () => Array<object>): UpdateFeed {
    const source = UPDATES.find(update => update.name === name)!;
    return new UpdateFeed({ ...source, search: async () => list() } as UpdateSource);
}

const rule = (id: number, label: string, updater = 10): object => ({ id, label, pattern: "\\Ahttps://x/", replacement: "", message: "no", handling: "block", enabled: true, creator_id: 10, updater_id: updater, created_at: at(60), updated_at: at(1) });
const entry = (id: number, note: string, domain = "x\\.test"): object => ({ id, note, domain, path: "\\/.+", hidden: false, allowed: true, reason: "", created_at: at(60), updated_at: at(1) });
const modAction = (id: number, action: string, values: object, creator: number): never => ({ id, action, values, creator_id: creator, created_at: at(1), updated_at: at(1) }) as never;

describe("upload url rules", () => {
    test("the first poll only stores them", async () => {
        await feed("upload_url_rules", () => [rule(1, "a"), rule(2, "b")]).poll();
        expect(await events()).toEqual([]);
        expect((await getSnapshot("upload_url_rule", 2))?.label).toBe("b");
    });

    test("creates, updates and destroys", async () => {
        let list = [rule(1, "a"), rule(2, "b")];
        const rules = feed("upload_url_rules", () => list);
        await rules.poll();
        await saveSnapshots("mod_action", [modAction(50, "upload_url_rule_delete", { label: "b" }, 77)]);
        list = [rule(1, "a, renamed", 12), rule(3, "c")];
        expect((await rules.poll()).published).toBe(3);
        const sent = await events();
        expect(sent.map(event => event.type).sort()).toEqual(["upload_url_rule.create", "upload_url_rule.destroy", "upload_url_rule.update"]);
        expect(sent.find(event => event.type === "upload_url_rule.update")).toMatchObject({ data: { id: 1, label: "a, renamed" }, context: { updater_id: 12 } });
        expect(sent.find(event => event.type === "upload_url_rule.create")).toMatchObject({ data: { id: 3 } });
        expect(sent.find(event => event.type === "upload_url_rule.destroy")).toMatchObject({ data: { id: 2 }, context: { updater_id: 77, previous: { id: 2, label: "b" } } });
        expect(await getSnapshot("upload_url_rule", 2)).toBeNull();
    });

    test("an empty list doesn't destroy everything", async () => {
        let list = [rule(1, "a")];
        const rules = feed("upload_url_rules", () => list);
        await rules.poll();
        list = [];
        await rules.poll();
        expect(await events()).toEqual([]);
        expect(await getSnapshot("upload_url_rule", 1)).not.toBeNull();
    });

    test("nothing is sent when nothing tracked changed", async () => {
        const rules = feed("upload_url_rules", () => [rule(1, "a")]);
        await rules.poll();
        await rules.poll();
        expect(await events()).toEqual([]);
    });
});

describe("upload whitelists", () => {
    test("who made a change comes from the mod action with its note", async () => {
        let list = [entry(1, "4chan")];
        const whitelists = feed("upload_whitelists", () => list);
        await whitelists.poll();
        await saveSnapshots("mod_action", [modAction(60, "upload_whitelist_update", { note: "4chan" }, 88), modAction(61, "upload_whitelist_delete", { note: "pixiv" }, 89)]);
        list = [entry(1, "4chan", "y\\.test"), entry(2, "pixiv")];
        await whitelists.poll();
        list = [entry(1, "4chan", "y\\.test")];
        await whitelists.poll();
        const sent = await events();
        expect(sent.map(event => event.type)).toEqual(["upload_whitelist.create", "upload_whitelist.update", "upload_whitelist.destroy"]);
        expect(sent[1]).toMatchObject({ data: { id: 1, domain: "y\\.test" }, context: { updater_id: 88 } });
        expect(sent[2]).toMatchObject({ data: { id: 2 }, context: { updater_id: 89, previous: { note: "pixiv" } } });
    });
});
