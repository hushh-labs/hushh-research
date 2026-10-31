import { expect, it, vi } from "vitest";
import {
  prepareNearbyCommand,
  performNearbyCheckIn,
  prepareNearbyCheckout,
  performNearbyCheckout,
} from "@/lib/one-location/command-nearby";
import type { OneLocationNearbyPresenceState } from "@/lib/one-location/types";

it("refreshes and pins checkout to the exact presence incarnation, with an old-server review", async () => {
  const presence = {
    status: "active",
    id: "00000000-0000-4000-8000-000000000001",
    version: 4,
    placeLabel: "Fixture venue",
  } as const;
  const read = vi.fn(
    async () => ({ presence, attendees: [] }) as OneLocationNearbyPresenceState,
  );
  expect(await prepareNearbyCheckout({ owner: "owner", read })).toMatchObject({
    status: "ready",
    binding: { owner: "owner", presenceId: presence.id, presenceVersion: 4 },
  });
  read.mockResolvedValueOnce({
    presence: {
      ...presence,
      version: undefined,
    } as OneLocationNearbyPresenceState["presence"],
    attendees: [],
  });
  expect(await prepareNearbyCheckout({ owner: "owner", read })).toMatchObject({
    status: "blocked",
    waitForUser: true,
  });
  read.mockResolvedValueOnce({ presence: null, attendees: [] });
  expect(await prepareNearbyCheckout({ owner: "owner", read })).toMatchObject({
    status: "ready",
    binding: { presenceId: null, presenceVersion: 0 },
  });
});

it("does not confuse a correlated old checkout receipt with a newer active check-in", async () => {
  const binding = {
    owner: "owner",
    presenceId: "presence",
    presenceVersion: 4,
  };
  const receipt = {
    operation_id: "operation",
    presence_id: "presence",
    version: 4,
    checked_out: true as const,
  };
  const state = {
    presence: { id: "presence", version: 6, status: "active" },
    attendees: [],
    checkoutReceipt: receipt,
  } as OneLocationNearbyPresenceState;
  const save = vi.fn(async () => state);
  const input = {
    binding,
    operationId: "operation",
    current: () => true,
    save,
  };
  expect(await performNearbyCheckout(input)).toBe(state);
  await expect(
    performNearbyCheckout({
      ...input,
      binding: { ...binding, presenceVersion: 6 },
    }),
  ).rejects.toThrow("correlated receipt");
  const before = save.mock.calls.length;
  await expect(
    performNearbyCheckout({ ...input, signal: AbortSignal.abort() }),
  ).rejects.toThrow("interrupted");
  await expect(
    performNearbyCheckout({ ...input, current: () => false }),
  ).rejects.toThrow("interrupted");
  expect(save).toHaveBeenCalledTimes(before);
  await expect(
    performNearbyCheckout({
      current: () => true,
      save: async () => ({ presence: null, attendees: [] }),
    }),
  ).rejects.toThrow("did not confirm");
});

it("refreshes an exact prior place and retains it while choosing a supported duration", async () => {
  const details = vi.fn(async (placeId: string) => ({
    placeId,
    label: "Actual restaurant",
  }));
  const input = {
    owner: "owner",
    slots: { duration_minutes: 45 },
    candidates: [],
    currentPresence: null,
    details,
    resources: { place: [{ kind: "place" as const, id: "provider-result" }] },
  };
  const choice = await prepareNearbyCommand(input);
  expect(details).toHaveBeenCalledWith("provider-result");
  if (choice.status !== "blocked") throw Error("duration choice required");
  expect(choice.choices?.map((item) => item.label)).toEqual([
    "30 minutes",
    "60 minutes",
    "120 minutes",
  ]);
  const ready = await prepareNearbyCommand({
    ...input,
    choice: choice.choices![1]!.id,
  });
  expect(ready).toMatchObject({
    status: "ready",
    binding: {
      owner: "owner",
      placeId: "provider-result",
      durationMinutes: 60,
      allowConnectionRequests: false,
    },
  });
  expect(ready.summary).toContain("Show your name");
  details.mockResolvedValueOnce({ placeId: "different-place", label: "Other" });
  expect((await prepareNearbyCommand(input)).status).toBe("blocked");
});

it("keeps ambiguous places separate and never publishes while preparing a choice", async () => {
  const details = vi.fn();
  const result = await prepareNearbyCommand({
    owner: "owner",
    slots: { place: "Cafe", duration_minutes: 60 },
    candidates: [
      { placeId: "a", name: "Cafe" },
      { placeId: "b", name: "Cafe" },
    ],
    currentPresence: null,
    details,
  });
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.choices).toHaveLength(2);
  expect(details).not.toHaveBeenCalled();
});

it("requires real consent and correlated service settlement, and cancels before dispatch", async () => {
  const point = {
    latitude: 0,
    longitude: 0,
    capturedAt: "2026-09-13T00:00:00Z",
    accuracyM: 20,
  };
  const save = vi.fn(async () => ({ presence: null, attendees: [] }));
  const input = {
    placeId: "a",
    durationMinutes: 60 as const,
    consentAccepted: true,
    allowConnectionRequests: false,
    operationId: "operation",
    capture: async () => point,
    current: () => true,
    save,
  };
  await expect(
    performNearbyCheckIn({ ...input, consentAccepted: false }),
  ).rejects.toThrow("Review");
  expect(save).not.toHaveBeenCalled();
  const abort = new AbortController();
  await expect(
    performNearbyCheckIn({
      ...input,
      signal: abort.signal,
      capture: async () => {
        abort.abort();
        return point;
      },
    }),
  ).rejects.toThrow("interrupted");
  expect(save).not.toHaveBeenCalled();
  await expect(performNearbyCheckIn(input)).rejects.toThrow(
    "correlated save receipt",
  );
  const receipt = {
    operation_id: "operation",
    presence_id: "presence",
    version: 1,
    expires_at: "2026-09-13T01:00:00Z",
  };
  const result = await performNearbyCheckIn({
    ...input,
    save: async () => ({
      presence: null,
      attendees: [],
      operationReceipt: receipt,
    }),
  });
  expect(result.state.operationReceipt).toEqual(receipt);
});
