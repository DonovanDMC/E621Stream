import { describe, expect, test } from "bun:test";

import { split } from "../src/backfill/crawl.ts";

describe("crawl lanes", () => {
    test("cover every id below the top exactly once", () => {
        for (const top of [1, 2, 3, 681_145, 997_362]) {
            const lanes = split(top);
            expect(lanes[0]!.cursor).toBe(top);
            expect(lanes.at(-1)!.lower).toBe(0);
            for (let i = 1; i < lanes.length; i++) expect(lanes[i]!.cursor).toBe(lanes[i - 1]!.lower);
            expect(lanes.reduce((total, lane) => total + lane.cursor - lane.lower, 0)).toBe(top);
        }
    });

    test("splits the range into two", () => {
        expect(split(681_145)).toEqual([{ cursor: 681_145, lower: 340_572 }, { cursor: 340_572, lower: 0 }]);
    });
});
