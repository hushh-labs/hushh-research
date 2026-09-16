import { describe, expect, it, vi } from "vitest";
import {
  prepareCircleMembership,
  executeCircleMembership,
  type CircleMembershipPorts,
  type CircleMembershipBinding,
} from "@/lib/one-location/command-circle-membership";
import { commandContinuation } from "@/lib/one-location/command-continuation";

it("resumes only original remaining membership batches after current members and the directory change", async () => {
  const { ports } = fixture();
  const original = await prepareCircleMembership({
    owner: "owner",
    slots: { audience: "all_connections" },
    resources,
    ports,
  });
  if (original.status !== "ready") throw Error();
  const continuation = commandContinuation(
    {
      kind: "membership",
      operation_id: "a".repeat(64),
      snapshot: "b".repeat(64),
      total_units: 3,
      completed_unit_indices: [0],
      pending_unit_indices: [1, 2],
    },
    original.binding,
  );
  const binding = original.binding as CircleMembershipBinding;
  const pending = binding.people.slice(20);
  const later = fixture([
    ...pending,
    { userId: "new-unselected", displayName: "New person" },
  ]);
  const prepared = await prepareCircleMembership({
    owner: "owner",
    slots: { audience: "all_connections" },
    ports: later.ports,
    continuation,
  });
  expect(prepared).toMatchObject({
    status: "ready",
    binding: original.binding,
  });
  const add = vi.fn(async (ids: string[]) => ({
    added: ids,
    skipped: [],
    skippedReasons: {},
    invited: [],
  }));
  const result = await executeCircleMembership({ binding, continuation, add });
  expect(add.mock.calls.map((call) => (call as unknown[])[1])).toEqual([1, 2]);
  expect(add.mock.calls.flatMap(([ids]) => ids)).toEqual(
    pending.map((person) => person.userId),
  );
  expect(result.completedEarlier).toHaveLength(20);
  expect(result.added).toHaveLength(25);
  const missing = fixture(pending.slice(1));
  expect(
    (
      await prepareCircleMembership({
        owner: "owner",
        slots: {},
        ports: missing.ports,
        continuation,
      })
    ).status,
  ).toBe("blocked");
});

const people = Array.from({ length: 45 }, (_, i) => ({
  userId: `person-${i}`,
  displayName: `Person ${i}`,
}));
function fixture(names = people) {
  const events: string[] = [];
  const ports: CircleMembershipPorts = {
    circles: vi.fn(async () => [{ id: "wrong-same-name", name: "Goa" }]),
    overview: vi.fn(
      async (id) =>
        ({
          id,
          name: "Goa",
          viewerCapabilities: { canInviteMembers: true },
        }) as never,
    ),
    eligible: vi.fn(async (_id, page) => {
      events.push(`read:${page}`);
      return {
        eligibleConnections: names.slice((page - 1) * 20, page * 20),
        page,
        hasMore: page * 20 < names.length,
        totalCount: names.length,
        remainingCapacity: 50,
        pendingInvites: [],
      } as never;
    }),
    members: vi.fn(async () => ({
      items: [],
      page: 1,
      hasMore: false,
      totalCount: 0,
    })),
  };
  return { ports, events };
}
const resources = {
  circle: [
    {
      kind: "circle" as const,
      id: "created-circle",
      sourceStep: 0,
      operationId: "created-operation",
    },
  ],
};

describe("circle command preparation and outcome", () => {
  it("reads the whole audience before batching and uses the exact created resource", async () => {
    const { ports, events } = fixture();
    const prepared = await prepareCircleMembership({
      owner: "owner",
      slots: { audience: "all_connections" },
      resources,
      ports,
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw Error("missing preparation");
    expect(ports.circles).not.toHaveBeenCalled();
    expect(ports.overview).toHaveBeenCalledWith("created-circle");
    const binding = prepared.binding as CircleMembershipBinding;
    expect(binding.people).toHaveLength(45);
    const counts: number[] = [];
    const result = await executeCircleMembership({
      binding,
      add: async (ids) => {
        events.push("write");
        counts.push(ids.length);
        return { added: ids, skipped: [], skippedReasons: {}, invited: [] };
      },
    });
    expect(events).toEqual([
      "read:1",
      "read:2",
      "read:3",
      "write",
      "write",
      "write",
    ]);
    expect(counts).toEqual([20, 20, 5]);
    expect(result.added).toHaveLength(45);
  });

  it("keeps everyone while resolving more than one ambiguous name", async () => {
    const { ports } = fixture([
      { userId: "a1", displayName: "Abdul A" },
      { userId: "a2", displayName: "Abdul B" },
      { userId: "s1", displayName: "Sam A" },
      { userId: "s2", displayName: "Sam B" },
    ]);
    const input = {
      owner: "owner",
      slots: { person: "Abdul, Sam" },
      resources,
      ports,
    };
    const first = await prepareCircleMembership(input);
    expect(first.status).toBe("blocked");
    if (first.status !== "blocked") throw Error("missing choice");
    const second = await prepareCircleMembership({
      ...input,
      choice: first.choices![0]!.id,
    });
    expect(second.status).toBe("blocked");
    if (second.status !== "blocked") throw Error("missing second choice");
    const ready = await prepareCircleMembership({
      ...input,
      choice: second.choices![1]!.id,
    });
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw Error("missing preparation");
    expect(
      (ready.binding as CircleMembershipBinding).people.map(
        (person) => person.userId,
      ),
    ).toEqual(["a1", "s2"]);
    expect(ready.binding.circleId).toBe("created-circle");
  });

  it("rejects stalled pagination, changed totals and insufficient full capacity", async () => {
    const { ports } = fixture();
    vi.mocked(ports.eligible).mockResolvedValue({
      eligibleConnections: [],
      page: 1,
      hasMore: true,
      totalCount: 2,
      remainingCapacity: 50,
      pendingInvites: [],
    });
    await expect(
      prepareCircleMembership({
        owner: "owner",
        slots: { audience: "all_connections" },
        resources,
        ports,
      }),
    ).rejects.toThrow("complete audience");
    const small = fixture();
    const read = small.ports.eligible;
    small.ports.eligible = async (id, page) => ({
      ...(await read(id, page)),
      remainingCapacity: 10,
    });
    const prepared = await prepareCircleMembership({
      owner: "owner",
      slots: { audience: "all_connections" },
      resources,
      ports: small.ports,
    });
    expect(prepared.status).toBe("blocked");
    expect(prepared.summary).toContain("selection needs 45");
  });

  it("preserves committed results and stops on a lost batch response", async () => {
    const result = await executeCircleMembership({
      binding: {
        owner: "owner",
        circleId: "circle",
        circleName: "Goa",
        sourceReceipt: null,
        people,
      },
      add: async (ids, batch) => {
        if (batch === 1) throw Error("response lost after commit");
        return {
          added: ids.slice(1),
          skipped: [ids[0]!],
          skippedReasons: { [ids[0]!]: "already_member" },
          invited: [],
        };
      },
    });
    expect(result.added).toHaveLength(19);
    expect(result.skipped).toHaveLength(1);
    expect(result.unknown).toHaveLength(20);
    expect(result.notAttempted).toHaveLength(5);
  });

  it("cancellation prevents the next batch and legacy invites are not added members", async () => {
    const abort = new AbortController();
    const add = vi.fn(async (ids: string[]) => {
      abort.abort();
      return { added: [], skipped: [], skippedReasons: {}, invited: ids };
    });
    const result = await executeCircleMembership({
      binding: {
        owner: "owner",
        circleId: "circle",
        circleName: "Goa",
        sourceReceipt: null,
        people,
      },
      signal: abort.signal,
      add,
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(result.added).toEqual([]);
    expect(result.invited).toHaveLength(20);
    expect(result.notAttempted).toHaveLength(25);
  });
});
