import { expect, it, vi } from "vitest";
import {
  prepareLocationAudience,
  resolveAuthoritativePreparedAudience,
  resolvePreparedAudience,
} from "@/lib/one-location/command-audience";
import {
  commandContinuation,
  pendingAudienceBinding,
} from "@/lib/one-location/command-continuation";

it("refreshes only unfinished original recipients and does not add new Circle members", async () => {
  const selected = await prepareLocationAudience({
    ...base,
    slots: { circle: "Goa", duration_hours: "2" },
    extra: { replacements: [] },
  });
  if (selected.status !== "ready") throw Error();
  const continuation = commandContinuation(
    {
      kind: "audience",
      operation_id: "a".repeat(64),
      snapshot: "b".repeat(64),
      total_units: 4,
      completed_unit_indices: [0, 2],
      pending_unit_indices: [1, 3],
    },
    selected.binding,
  );
  const current = {
    ...base,
    continuation,
    people: [
      people[1]!,
      people[3]!,
      { id: "new", name: "New person", keyId: "new-key", ready: true },
    ],
    members: async () => [{ userId: "b" }, { userId: "d" }, { userId: "new" }],
    extra: {
      message: "unrelated changed composer text",
      replacements: [{ id: "completed-share", recipientUserId: "a" }],
    },
  };
  expect(await prepareLocationAudience(current)).toMatchObject({
    status: "ready",
    binding: selected.binding,
  });
  expect(
    pendingAudienceBinding(selected.binding, continuation).recipientIds,
  ).toEqual(["b", "d"]);
  expect(
    (
      await prepareLocationAudience({
        ...current,
        people: current.people.map((person) => ({
          ...person,
          keyId: "rotated",
        })),
      })
    ).status,
  ).toBe("blocked");
  expect(
    (
      await prepareLocationAudience({
        ...current,
        members: async () => [{ userId: "d" }],
      })
    ).status,
  ).toBe("blocked");
  expect(
    (
      await prepareLocationAudience({
        ...current,
        extra: {
          replacements: [{ id: "changed-pending-share", recipientUserId: "b" }],
        },
      })
    ).status,
  ).toBe("blocked");
});

it("rejects overlapping, missing or out-of-bounds receipt indices", () => {
  const binding = { owner: "owner", recipientIds: ["a", "b"], people: [] };
  const proof = {
    kind: "audience" as const,
    operation_id: "a".repeat(64),
    snapshot: "b".repeat(64),
    total_units: 2,
    completed_unit_indices: [0],
    pending_unit_indices: [1],
  };
  expect(() =>
    commandContinuation({ ...proof, pending_unit_indices: [0] }, binding),
  ).toThrow("indices");
  expect(() =>
    commandContinuation({ ...proof, pending_unit_indices: [2] }, binding),
  ).toThrow("indices");
  expect(() =>
    commandContinuation({ ...proof, completed_unit_indices: [] }, binding),
  ).toThrow("indices");
});
const people = [
  { id: "a", name: "Abdul", keyId: "ka", ready: true },
  { id: "b", name: "Abdul", keyId: "kb", ready: true },
  { id: "c", name: "Ankit", keyId: "kc", ready: true },
  { id: "d", name: "Ankit", keyId: "kd", ready: true },
];
const base = {
  owner: "owner",
  kind: "share" as const,
  slots: { person: "Abdul and Ankit", duration_hours: "2" },
  selectedIds: [],
  people,
  durations: ["1", "2"],
  extra: {},
  circles: async () => [{ id: "goa", name: "Goa" }],
  members: async () => [
    { userId: "owner" },
    ...people.map((p) => ({ userId: p.id })),
  ],
};

it("retains every named person through multiple ambiguous choices and one audience review", async () => {
  const first = await prepareLocationAudience(base);
  expect(first.status).toBe("blocked");
  if (first.status !== "blocked") throw Error();
  const second = await prepareLocationAudience({
    ...base,
    choice: first.choices![1]!.id,
  });
  expect(second.status).toBe("blocked");
  if (second.status !== "blocked") throw Error();
  const result = await prepareLocationAudience({
    ...base,
    choice: second.choices![0]!.id,
  });
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw Error();
  expect(result.binding.recipientIds).toEqual(["b", "c"]);
});

it("includes the full refreshed circle and keeps its audience while asking for duration", async () => {
  const input = { ...base, slots: { circle: "Goa" } };
  const pending = await prepareLocationAudience(input);
  if (pending.status !== "blocked") throw Error();
  const result = await prepareLocationAudience({
    ...input,
    choice: pending.choices![1]!.id,
  });
  if (result.status !== "ready") throw Error();
  expect(result.binding.recipientIds).toEqual(["a", "b", "c", "d"]);
  expect(result.binding.duration).toBe("2");
  expect(result.binding.sourceCircleByRecipient).toEqual({
    a: "goa",
    b: "goa",
    c: "goa",
    d: "goa",
  });
});

it("never drops an unavailable circle member or a changed named reference", async () => {
  const result = await prepareLocationAudience({
    ...base,
    slots: { circle: "Goa", duration_hours: "2" },
    members: async () => [{ userId: "a" }, { userId: "missing" }],
  });
  expect(result.status).toBe("blocked");
  const referenced = await prepareLocationAudience({
    ...base,
    slots: { duration_hours: "2" },
    resources: { person: [{ kind: "person", id: "missing" }] },
  });
  expect(referenced.status).toBe("blocked");
});

it("re-reads exact recipients and keys at dispatch rather than using a partial picker", () => {
  const binding = {
    owner: "owner",
    recipientIds: ["a", "c"],
    people: [people[0], people[2]],
  };
  const pool = people.map((person) => ({
    userId: person.id,
    keyId: person.keyId,
  }));
  expect(
    resolvePreparedAudience(binding, pool, "owner").map((p) => p.userId),
  ).toEqual(["a", "c"]);
  expect(() =>
    resolvePreparedAudience(binding, pool.slice(0, 2), "owner"),
  ).toThrow("omitted");
  expect(() =>
    resolvePreparedAudience(
      binding,
      pool.map((p) => ({ ...p, keyId: "rotated" })),
      "owner",
    ),
  ).toThrow("setup changed");
  expect(
    resolvePreparedAudience(
      binding,
      pool.map((p) => ({ ...p, keyId: "rotated" })),
      "owner",
      { requireEncryptionKey: false },
    ).map((p) => p.userId),
  ).toEqual(["a", "c"]);
  expect(() =>
    resolvePreparedAudience(binding, pool.slice(0, 2), "owner", {
      requireEncryptionKey: false,
    }),
  ).toThrow("omitted");
  expect(() => resolvePreparedAudience(binding, pool, "other")).toThrow(
    "unavailable",
  );
});

it("revalidates the reviewed Circle membership immediately before dispatch", async () => {
  const binding = {
    owner: "owner",
    recipientIds: ["a", "c"],
    people: [people[0], people[2]],
    sourceCircleByRecipient: { a: "goa", c: "goa" },
  };
  const pool = people.map((person) => ({
    userId: person.id,
    keyId: person.keyId,
  }));
  const readCircleMembers = vi.fn(async () => [
    { userId: "owner" },
    { userId: "a" },
    { userId: "c" },
  ]);

  await expect(
    resolveAuthoritativePreparedAudience({
      binding,
      pool,
      owner: "owner",
      readCircleMembers,
    }),
  ).resolves.toEqual([pool[0], pool[2]]);
  expect(readCircleMembers).toHaveBeenCalledOnce();

  readCircleMembers.mockResolvedValueOnce([
    { userId: "owner" },
    { userId: "a" },
  ]);
  await expect(
    resolveAuthoritativePreparedAudience({
      binding,
      pool,
      owner: "owner",
      readCircleMembers,
    }),
  ).rejects.toThrow("Circle membership changed");
});

it("does not fetch a Circle roster for an explicitly direct audience", async () => {
  const readCircleMembers = vi.fn();
  const pool = [{ userId: "a", keyId: "ka" }];
  await expect(
    resolveAuthoritativePreparedAudience({
      binding: {
        owner: "owner",
        recipientIds: ["a"],
        people: [people[0]],
        sourceCircleByRecipient: { a: null },
      },
      pool,
      owner: "owner",
      readCircleMembers,
    }),
  ).resolves.toEqual(pool);
  expect(readCircleMembers).not.toHaveBeenCalled();
});

it("retains a person chosen from the card while asking for duration", async () => {
  const input = { ...base, slots: {}, selectedIds: [] };
  const who = await prepareLocationAudience(input);
  if (who.status !== "blocked") throw Error();
  const duration = await prepareLocationAudience({
    ...input,
    choice: who.choices![0]!.id,
  });
  if (duration.status !== "blocked") throw Error();
  const ready = await prepareLocationAudience({
    ...input,
    choice: duration.choices![0]!.id,
  });
  if (ready.status !== "ready") throw Error();
  expect(ready.binding.recipientIds).toEqual(["a"]);
  expect(ready.binding.duration).toBe("1");
});

it("preserves circle, duration and earlier choices while a referenced person needs Connect", async () => {
  const choice =
    "location-audience:" +
    JSON.stringify({ people: { "0": "a" }, circleId: "goa", duration: "2" });
  const result = await prepareLocationAudience({
    ...base,
    slots: {},
    choice,
    resources: { person: [{ kind: "person", id: "unconnected" }] },
    connectionPrerequisite: async (input) => ({
      status: "blocked",
      gate: "navigation",
      waitForUser: true,
      resolvedChoiceId: input.choiceForPerson(input.personId!),
      summary: "Connect first",
    }),
  });
  expect(result).toMatchObject({ status: "blocked", resolvedChoiceId: choice });
});
