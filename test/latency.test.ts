import { describe, expect, test } from "bun:test";

import { latencyAlertMS } from "../src/config.ts";
import { evaluate, type LatencyState, type Sample } from "../src/latency.ts";

const samples = (ms: number, count = 20): Array<Sample> => Array.from({ length: count }, () => ({ at: Date.now(), failed: false, ms }));
const slow = samples(latencyAlertMS + 1000), fast = samples(300);

describe("latency", () => {
    test("goes elevated once the median reaches the limit", () => {
        const start: LatencyState = { calm: 0, latency: null };
        expect(evaluate(start, fast).change).toBeNull();
        const next = evaluate(start, [...fast.slice(0, 9), ...slow.slice(0, 11)]);
        expect(next.change).toBe("elevated");
        expect(next.latency?.elevated).toBe(true);
    });

    test("only recovers after 3 checks in a row under the limit", () => {
        let state: LatencyState = evaluate({ calm: 0, latency: null }, slow, new Date("2026-11-18T00:00:00Z"));
        const changes: Array<string | null> = [];
        for (const batch of [fast, fast, slow, fast, fast, fast]) {
            const next = evaluate(state, batch, new Date("2026-11-18T01:00:00Z"));
            changes.push(next.change);
            state = next;
        }
        expect(changes).toEqual([null, null, null, null, null, "recovered"]);
        expect(state.latency?.elevated).toBe(false);
    });

    test("says when a recovered spell started", () => {
        const elevated = evaluate({ calm: 0, latency: null }, slow, new Date("2026-11-18T00:00:00Z"));
        let state: LatencyState = elevated;
        let last: ReturnType<typeof evaluate> | null = null;
        for (let i = 0; i < 3; i++) state = last = evaluate(state, fast);
        expect(last?.elevatedAt).toBe("2026-11-18T00:00:00.000Z");
    });

    test("leaves the state alone without enough requests to go on", () => {
        const state = evaluate({ calm: 0, latency: null }, slow);
        const next = evaluate(state, fast.slice(0, 3));
        expect(next.change).toBeNull();
        expect(next.latency).toBe(state.latency);
    });

    test("failures count", () => {
        const next = evaluate({ calm: 0, latency: null }, [...slow.map(s => ({ ...s, failed: true })), ...fast]);
        expect(next.latency?.failed).toBe(20);
        expect(next.latency?.requests).toBe(40);
    });
});
