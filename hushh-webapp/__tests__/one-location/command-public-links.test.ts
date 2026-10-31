import { expect, it, vi } from "vitest";
import {
  findReviewedPublicLink,
  preparePublicLink,
  verifyPublicLinkReceipt,
} from "@/lib/one-location/command-public-links";
import type { OneLocationPublicInvite } from "@/lib/one-location/types";

const link = (id = "first"): OneLocationPublicInvite => ({
  id,
  ownerUserId: "owner",
  status: "active",
  durationHours: 1,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  publicUrl: "https://example.test/synthetic",
});
const base = {
  owner: "owner",
  action: "location.create_public_link" as const,
  slots: {},
  durationOptions: ["0.25", "0.5", "1"],
  read: async () => [] as OneLocationPublicInvite[],
};

it("reviews a new public disclosure with the authored duration and exact existing URL", async () => {
  expect(await preparePublicLink(base)).toMatchObject({
    status: "ready",
    binding: { durationHours: 1, activeInvite: null },
    summary: expect.stringContaining("Anyone holding"),
  });
  const active = link();
  expect(
    await preparePublicLink({
      ...base,
      read: async () => [active],
      slots: { duration_hours: 0.5 },
    }),
  ).toMatchObject({
    status: "ready",
    binding: {
      durationHours: 0.5,
      activeInvite: { id: active.id, expiresAt: active.expiresAt },
    },
    summary: expect.stringContaining("already have this URL"),
  });
});

it("asks for an authored duration without rounding unsupported input", async () => {
  expect(
    await preparePublicLink({ ...base, slots: { duration_hours: 2 } }),
  ).toMatchObject({
    status: "blocked",
    gate: "input",
    choices: [
      { id: "duration:0.25" },
      { id: "duration:0.5" },
      { id: "duration:1" },
    ],
  });
  expect(
    await preparePublicLink({
      ...base,
      slots: { duration_hours: 2 },
      choice: "duration:0.25",
    }),
  ).toMatchObject({ status: "ready", binding: { durationHours: 0.25 } });
});

it.each(["location.share_public_link", "location.revoke_public_link"] as const)(
  "never substitutes a remaining link for an explicit expired selection: %s",
  async (action) => {
    const first = link(),
      second = link("second");
    expect(
      await preparePublicLink({
        ...base,
        action,
        read: async () => [first, second],
      }),
    ).toMatchObject({
      status: "blocked",
      choices: [{ id: "first" }, { id: "second" }],
    });
    expect(
      await preparePublicLink({
        ...base,
        action,
        choice: "first",
        read: async () => [second],
      }),
    ).toMatchObject({ status: "blocked", choices: [{ id: "second" }] });
    expect(
      await preparePublicLink({
        ...base,
        action,
        choice: "first",
        read: async () => [first, second],
      }),
    ).toMatchObject({
      status: "ready",
      binding: { activeInvite: { id: "first" } },
    });
  },
);

it("opens the browser's real Share control once and keeps native handoff executable", async () => {
  const active = link(),
    showReviewedLink = vi.fn();
  const args = {
    ...base,
    action: "location.share_public_link" as const,
    read: async () => [active],
    showReviewedLink,
  };
  expect(
    await preparePublicLink({ ...args, needsShareGesture: true }),
  ).toMatchObject({
    status: "simulate",
    summary: expect.stringContaining("has not been sent"),
  });
  expect(showReviewedLink).toHaveBeenCalledWith(active);
  expect(
    await preparePublicLink({ ...args, needsShareGesture: false }),
  ).toMatchObject({ status: "ready" });
});

it("rejects stale, foreign and non-derivable links before a handoff", async () => {
  const active = link(),
    binding = {
      owner: "owner",
      action: "location.share_public_link" as const,
      activeInvite: { id: active.id, expiresAt: active.expiresAt! },
    };
  expect(findReviewedPublicLink([active], binding, "owner")).toEqual(active);
  for (const changed of [
    { ...active, ownerUserId: "other" },
    { ...active, status: "revoked" as const },
    { ...active, expiresAt: new Date(Date.now() + 300_000).toISOString() },
    { ...active, publicUrl: undefined },
  ])
    expect(() => findReviewedPublicLink([changed], binding, "owner")).toThrow();
  expect(
    await preparePublicLink({
      ...base,
      read: async () => [{ ...active, publicUrl: undefined }],
    }),
  ).toMatchObject({ status: "blocked", gate: "navigation" });
});

it("accepts only the owning service's correlated operation result", () => {
  const active = link(),
    receipt = {
      operation_id: "operation",
      invite_id: active.id,
      status: "active" as const,
      expires_at: active.expiresAt!,
      reused: false,
    };
  expect(() =>
    verifyPublicLinkReceipt(receipt, "operation", active, "create"),
  ).not.toThrow();
  expect(() =>
    verifyPublicLinkReceipt(receipt, "different", active, "create"),
  ).toThrow();
  expect(() =>
    verifyPublicLinkReceipt(receipt, "operation", link("other"), "create"),
  ).toThrow();
  expect(() =>
    verifyPublicLinkReceipt(receipt, "operation", active, "revoke"),
  ).toThrow();
});
