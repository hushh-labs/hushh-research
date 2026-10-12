import { describe, expect, it } from "vitest";

import {
  appendPage,
  createPagedHistory,
  reconcileHead,
  upsertItems,
  type PagedHistoryOrder,
} from "@/lib/payouts/paged-history";

type Row = { id: string; at: number; state: string; version: number };

const row = (id: string, at: number, state = "pending", version = 1): Row => ({ id, at, state, version });
const order: PagedHistoryOrder<Row> = {
  id: (item) => item.id,
  compare: (a, b) => b.at - a.at,
  replaces: (incoming, current) => incoming.version >= current.version,
};
const page = (items: Row[], nextCursor: string | null) => ({ items, nextCursor });
const ids = (state: { items: readonly Row[] }) => state.items.map((item) => item.id);

describe("payout paged history", () => {
  it("keeps older pages and their cursor when a refresh overlaps, updating rows in place", () => {
    let state = reconcileHead(createPagedHistory<Row>(), page([row("r5", 5), row("r4", 4)], "c4"), order);
    state = appendPage(state, page([row("r3", 3), row("r2", 2)], "c2"), "c4", order);
    expect(state.nextCursor).toBe("c2");

    // One new row and a state change on a loaded row: the chain is unbroken.
    state = reconcileHead(state, page([row("n6", 6), row("r5", 5, "paid", 2)], "c5"), order);
    expect(ids(state)).toEqual(["n6", "r5", "r4", "r3", "r2"]);
    expect(state.items[1].state).toBe("paid");
    expect(state.nextCursor).toBe("c2");

    // A late, older copy of a row never overwrites the newer state.
    state = reconcileHead(state, page([row("n6", 6), row("r5", 5, "pending", 1)], "c5"), order);
    expect(state.items[1].state).toBe("paid");
  });

  it("restarts the cursor after a full page of new rows and keeps what was loaded", () => {
    let state = reconcileHead(createPagedHistory<Row>(), page([row("r2", 2), row("r1", 1)], "c1"), order);
    state = reconcileHead(state, page([row("n4", 4), row("n3", 3)], "c3"), order);
    expect(ids(state)).toEqual(["n4", "n3", "r2", "r1"]);
    // The rows between the new head and the old one are unknown, so they load next.
    expect(state.nextCursor).toBe("c3");

    const gap = appendPage(state, page([row("g25", 2.5), row("r2", 2)], "c2"), "c3", order);
    expect(ids(gap)).toEqual(["n4", "n3", "g25", "r2", "r1"]);
    expect(gap.nextCursor).toBe("c2");
  });

  it("ignores a More response whose cursor a refresh replaced", () => {
    let state = reconcileHead(createPagedHistory<Row>(), page([row("r2", 2), row("r1", 1)], "c1"), order);
    state = reconcileHead(state, page([row("n4", 4), row("n3", 3)], "c3"), order);
    // Requested with the old cursor before the refresh landed: appending it
    // would skip the gap and end the chain early.
    const raced = appendPage(state, page([row("r0", 0)], null), "c1", order);
    expect(raced).toBe(state);
    expect(raced.nextCursor).toBe("c3");
  });

  it("updates loaded rows in place and leaves older unloaded rows to their page", () => {
    let state = reconcileHead(createPagedHistory<Row>(), page([row("r5", 5), row("r4", 4)], "c4"), order);
    state = upsertItems(state, [row("r4", 4, "paid", 2), row("r1", 1, "paid", 2), row("n6", 6, "pending", 1)], order);
    expect(ids(state)).toEqual(["n6", "r5", "r4"]);
    expect(state.items[2].state).toBe("paid");
    expect(state.nextCursor).toBe("c4");
  });
});
