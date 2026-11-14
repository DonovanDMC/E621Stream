import { expect, test } from "bun:test";

import { dispatchFrame, isNotice, noticeFrame, parseEntry, type StreamEvent, type StreamNotice } from "../src/events.ts";

test("recovered events are flagged", () => {
    const event = parseEntry(["5-0", ["t", "post.create", "ts", "2026-11-14T03:00:00Z", "d", "{\"post\":{\"id\":1}}", "r", "r1"]]) as StreamEvent;
    expect(event.recovered).toBe(true);
    expect(JSON.parse(dispatchFrame(event))).toEqual({ op: "dispatch", id: "5-0", type: "post.create", time: "2026-11-14T03:00:00Z", recovered: true, data: { post: { id: 1 } } });
    const live = parseEntry(["6-0", ["t", "post.create", "ts", "", "d", "{}"]]) as StreamEvent;
    expect(live.recovered).toBe(false);
    expect("recovered" in JSON.parse(dispatchFrame(live))).toBe(false);
});

test("recovery notices", () => {
    const d = { id: "r1", from: "a", to: "b", sources: ["posts"], done: false };
    const notice = parseEntry(["7-0", ["t", "recovery", "d", JSON.stringify(d)]]);
    expect(notice && isNotice(notice)).toBe(true);
    expect(JSON.parse(noticeFrame(notice as StreamNotice))).toEqual({ op: "recovery", id: "7-0", d });
    expect(parseEntry(["8-0", ["t", "nope", "d", "{}"]])).toBeNull();
});
