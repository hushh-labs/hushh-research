import { describe, expect, it } from "vitest";

import { LiveActivityRing } from "@/lib/pkm/live-activity/live-activity-ring";
import { normalizeLiveActivityInput, type LiveActivityInput } from "@/lib/pkm/live-activity/live-activity-types";

const input = (value: LiveActivityInput) => normalizeLiveActivityInput(value)!;

describe("LiveActivityRing", () => {
  it("coalesces a repeat inside the window and appends otherwise", () => {
    const ring = new LiveActivityRing();
    let seq = 0;
    const next = () => ++seq;
    ring.push(input({ kind: "section_opened", subject: "location", at: 1_000 }), "s1", next, 60_000);
    const merged = ring.push(input({ kind: "section_opened", subject: "location", at: 30_000 }), "s1", next, 60_000);
    expect(merged).toMatchObject({ id: "s1:1", seq: 1, count: 2, firstAt: 1_000, lastAt: 30_000 });

    ring.push(input({ kind: "section_opened", subject: "files", at: 31_000 }), "s1", next, 60_000);
    ring.push(input({ kind: "section_opened", subject: "files", at: 200_000 }), "s1", next, 60_000);
    expect(ring.toArray().map(event => [event.seq, event.subject, event.count])).toEqual([
      [1, "location", 2], [2, "files", 1], [3, "files", 1],
    ]);
  });

  it("evicts the oldest event at capacity and keeps oldest-first order", () => {
    const ring = new LiveActivityRing(3);
    let seq = 0;
    for (const subject of ["a", "b", "c", "d", "e"]) {
      ring.push(input({ kind: "section_opened", subject, at: 1_000 }), "s1", () => ++seq);
    }
    expect(ring.size).toBe(3);
    expect(ring.toArray().map(event => event.subject)).toEqual(["c", "d", "e"]);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.toArray()).toEqual([]);
  });
});
