import { expect, it, vi } from "vitest";
import { prepareLocationConnection } from "@/lib/one-location/command-connection";
import {
  ConnectionsServiceRequestError,
  type ConnectionPersonContext,
} from "@/lib/services/connections-service";

const person = {
  userId: "person-1",
  displayName: "Abdul",
  photoUrl: null,
  email: null,
  relationship: "none" as const,
};
const context = (
  relationship: ConnectionPersonContext["person"]["relationship"],
  status = "pending",
): ConnectionPersonContext => ({
  person: { ...person, relationship },
  request:
    relationship === "none"
      ? null
      : {
          id: "request-1",
          direction:
            relationship === "pending_incoming" ? "incoming" : "outgoing",
          status,
        },
});
const base = {
  name: "Abdul",
  choiceForPerson: (id: string) => `exact:${id}`,
  search: vi.fn(async () => ({
    items: [person],
    page: 1,
    hasMore: false,
    totalCount: 1,
  })),
};

it.each(["none", "pending_outgoing", "pending_incoming", "connected"] as const)(
  "keeps the exact person and waits for Connect when %s",
  async (relationship) => {
    const result = await prepareLocationConnection({
      ...base,
      context: async () => context(relationship),
    });
    expect(result).toMatchObject({
      status: "blocked",
      gate: "navigation",
      waitForUser: true,
      resolvedChoiceId: "exact:person-1",
    });
    if (result.status !== "blocked") throw Error();
    expect(result.route).toContain(
      relationship === "pending_incoming"
        ? "request-1"
        : "reviewPerson=person-1",
    );
    expect(result.summary).not.toMatch(
      /successfully connected|added successfully/,
    );
  },
);

it("offers ambiguous full-directory matches instead of inventing an identity", async () => {
  const read = vi.fn();
  const result = await prepareLocationConnection({
    ...base,
    context: read,
    search: async () => ({
      items: [person, { ...person, userId: "person-2" }],
      page: 1,
      hasMore: false,
      totalCount: 2,
    }),
  });
  expect(result).toMatchObject({
    status: "blocked",
    gate: "input",
    choices: [{ id: "exact:person-1" }, { id: "exact:person-2" }],
  });
  expect(read).not.toHaveBeenCalled();
});

it("refreshes an exact reference and reports unavailable targets without replacing them", async () => {
  const search = vi.fn();
  const result = await prepareLocationConnection({
    ...base,
    personId: "old-id",
    search,
    context: async () => {
      throw new ConnectionsServiceRequestError(404, "Unavailable");
    },
  });
  expect(result).toMatchObject({
    status: "blocked",
    gate: "input",
    summary: expect.stringContaining("no longer available"),
  });
  expect(search).not.toHaveBeenCalled();
});

it("does not reinterpret a provider failure as an absent connection", async () => {
  await expect(
    prepareLocationConnection({
      ...base,
      context: async () => {
        throw new ConnectionsServiceRequestError(503, "Try later");
      },
    }),
  ).rejects.toThrow("Try later");
});
