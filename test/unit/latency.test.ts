import { expect, test } from "bun:test";

import IngesterConfig from "../../src/config/IngesterConfig.ts";
import { evaluate } from "../../src/util/latency.ts";

const samples = (ms: number, count = 20): Array<{ at: number; failed: boolean; ms: number }> => Array.from({ length: count }, () => ({ at: Date.now(), failed: false, ms }));
const slow = IngesterConfig.latencyAlertMS, fast = Math.floor(IngesterConfig.latencyAlertMS / 4);

test("needs enough requests to say anything", () => {
    expect(evaluate({ calm: 0, latency: null }, samples(slow, 3)).change).toBeNull();
});

test("goes elevated, then recovers after a few calm checks", () => {
    let state = evaluate({ calm: 0, latency: null }, samples(fast));
    expect(state).toMatchObject({ change: null, latency: { elevated: false, requests: 20 } });
    state = evaluate(state, samples(slow));
    expect(state).toMatchObject({ change: "elevated", latency: { elevated: true } });
    const since = state.latency!.since;
    state = evaluate(state, samples(fast));
    state = evaluate(state, samples(fast));
    expect(state.change).toBeNull();
    // one slow check starts the count over
    state = evaluate(state, samples(slow));
    for (let i = 0; i < 2; i++) state = evaluate(state, samples(fast));
    expect(state.latency!.elevated).toBe(true);
    state = evaluate(state, samples(fast));
    expect(state).toMatchObject({ change: "recovered", elevatedAt: since, latency: { elevated: false } });
});
