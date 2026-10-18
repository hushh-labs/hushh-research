import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearWorldModelInvitationHandoffsForToken,
  createWorldModelInvitationHandoff,
  needsWorldModelInvitationAccountSwitch,
  readWorldModelInvitationHandoff,
  safeWorldModelInvitationReturnPath,
  switchWorldModelInvitationHandoffAccount,
  worldModelInvitationClaimRoute,
  worldModelInvitationHandoffRoute,
} from "@/lib/world-model/invitation-handoff";

const token = "a".repeat(43);

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps a capability in per-tab storage and binds its nonce to the first account", () => {
  const id = createWorldModelInvitationHandoff(token);
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  const invitation = worldModelInvitationHandoffRoute(id!);
  const claim = worldModelInvitationClaimRoute(id!);
  expect(invitation).toMatch(/^\/world-model\/invite\?handoff=/);
  expect(claim).toMatch(/^\/one\/profile\/world-model\?handoff=/);
  expect(invitation + claim).not.toContain(token);
  expect(readWorldModelInvitationHandoff(id!, null)).toBe(token);
  expect(readWorldModelInvitationHandoff(id!, "recipient-a")).toBe(token);
  expect(readWorldModelInvitationHandoff(id!, "recipient-b")).toBeNull();
  expect(needsWorldModelInvitationAccountSwitch(id!, "recipient-b")).toBe(true);
  expect(readWorldModelInvitationHandoff(id!, "recipient-a")).toBe(token);
  expect(switchWorldModelInvitationHandoffAccount(id!, "recipient-b")).toBe(token);
  expect(readWorldModelInvitationHandoff(id!, "recipient-b")).toBe(token);
  expect(readWorldModelInvitationHandoff(id!, "recipient-a")).toBeNull();
});

it("refuses a missing, expired, or malformed handoff", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  const id = createWorldModelInvitationHandoff(token)!;
  expect(readWorldModelInvitationHandoff("missing", "recipient")).toBeNull();
  vi.advanceTimersByTime(2 * 60 * 60 * 1000);
  expect(readWorldModelInvitationHandoff(id, "recipient")).toBeNull();
  expect(switchWorldModelInvitationHandoffAccount(id, "recipient")).toBeNull();
  expect(window.sessionStorage.length).toBe(0);
});

it("sanitizes direct PWM fragment entries before a guard adds a query wrapper", () => {
  const safe = safeWorldModelInvitationReturnPath(
    `/one/profile/world-model#claim=${token}`,
    "recipient",
  );
  expect(safe).toMatch(/^\/world-model\/invite\?handoff=/);
  expect(safe).not.toContain(token);
  expect(readWorldModelInvitationHandoff(new URL(safe, "https://one.local").searchParams.get("handoff")!, "recipient")).toBe(token);
  expect(safeWorldModelInvitationReturnPath("/one/feed#tab=home")).toBe("/one/feed#tab=home");
  expect(safeWorldModelInvitationReturnPath("http://[bad#claim=secret")).toBe("/world-model/invite");
});

it("fails closed if per-tab storage cannot save and clears successful decisions", () => {
  vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem").mockImplementationOnce(() => {
    throw new Error("blocked");
  });
  expect(createWorldModelInvitationHandoff(token)).toBeNull();
  const id = createWorldModelInvitationHandoff(token)!;
  clearWorldModelInvitationHandoffsForToken(token);
  expect(readWorldModelInvitationHandoff(id, null)).toBeNull();
});
