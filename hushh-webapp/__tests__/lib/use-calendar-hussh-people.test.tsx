import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCalendarHusshPeople } from "@/lib/calendar/use-calendar-hussh-people";
import { calendarHusshPerson } from "@/lib/calendar/calendar-hussh-people";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(), listEmailAliases: vi.fn(),
  graphListener: null as null | ((detail: { userId: string }) => void),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "owner", user: { email: "owner@example.test", emailVerified: true } }) }));
vi.mock("@/hooks/use-effective-avatar-url", () => ({ useEffectiveAvatarUrl: () => "data:image/png;base64,aGVsbG8=" }));
vi.mock("@/lib/auth/session-owner", () => ({
  getAuthSessionGeneration: () => 1,
  subscribeAuthSessionGeneration: () => () => undefined,
  snapshotValidatedAuthSessionOwner: () => ({ userId: "owner", generation: 1 }),
  isValidatedAuthSessionOwnerCurrent: () => true,
}));
vi.mock("@/lib/services/connections-service", () => ({ ConnectionsService: { listConnections: mocks.listConnections } }));
vi.mock("@/lib/services/account-service", () => ({ AccountService: { listEmailAliases: mocks.listEmailAliases } }));
vi.mock("@/lib/connections/connection-graph-events", () => ({
  subscribeToConnectionGraphChanges: (listener: (detail: { userId: string }) => void) => {
    mocks.graphListener = listener;
    return () => { mocks.graphListener = null; };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const connection = (photoUrl: string | null): ConnectionSummaryEntry => ({
  connectionId: "peer", userId: "peer", email: "peer@example.test", emailVerified: true,
  displayName: "Peer", photoUrl, createdAt: null,
});
const photo = "data:image/png;base64,aGVsbG8=";
const showPeer = (people: ReturnType<typeof useCalendarHusshPeople>) => calendarHusshPerson(people, "peer@example.test")?.photoUrl;

describe("Calendar HUSSH people lifecycle", () => {
  beforeEach(() => {
    mocks.listConnections.mockReset();
    mocks.listEmailAliases.mockReset().mockResolvedValue({ user_id: "owner", aliases: [] });
    mocks.graphListener = null;
  });

  it("clears the previous account snapshot and rejects a late response after switching", async () => {
    const first = deferred<ConnectionSummaryEntry[]>();
    const second = deferred<ConnectionSummaryEntry[]>();
    mocks.listConnections.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ accountKey }) => useCalendarHusshPeople({
      userId: "owner", accountKey, getIdToken: async () => "firebase-token", vaultOwnerToken: "vault-token",
    }), { initialProps: { accountKey: "first-account" } });
    await waitFor(() => expect(mocks.listConnections).toHaveBeenCalledTimes(1));
    expect(showPeer(result.current)).toBeUndefined();
    rerender({ accountKey: "second-account" });
    await waitFor(() => expect(mocks.listConnections).toHaveBeenCalledTimes(2));
    await act(async () => { first.resolve([connection(photo)]); await first.promise; });
    expect(showPeer(result.current)).toBeUndefined();
    await act(async () => { second.resolve([connection(photo)]); await second.promise; });
    await waitFor(() => expect(showPeer(result.current)).toBe(photo));
  });

  it("invalidates visible people immediately when owner permission changes", async () => {
    const renewed = deferred<ConnectionSummaryEntry[]>();
    mocks.listConnections.mockResolvedValueOnce([connection(photo)]).mockReturnValueOnce(renewed.promise);
    const { result, rerender } = renderHook(({ vaultOwnerToken }) => useCalendarHusshPeople({
      userId: "owner", accountKey: "default", getIdToken: async () => "firebase-token", vaultOwnerToken,
    }), { initialProps: { vaultOwnerToken: "first-token" } });
    await waitFor(() => expect(showPeer(result.current)).toBe(photo));

    rerender({ vaultOwnerToken: "renewed-token" });
    expect(showPeer(result.current)).toBeUndefined();
    await act(async () => { renewed.resolve([connection(null)]); await renewed.promise; });
    await waitFor(() => expect(calendarHusshPerson(result.current, "peer@example.test")?.photoUrl).toBeNull());
  });

  it("drops a removed photo after a connection graph change without affecting the owner", async () => {
    mocks.listConnections.mockResolvedValueOnce([connection(photo)]).mockResolvedValueOnce([connection(null)]);
    const { result } = renderHook(() => useCalendarHusshPeople({
      userId: "owner", accountKey: "default", getIdToken: async () => "firebase-token", vaultOwnerToken: "vault-token",
    }));
    await waitFor(() => expect(showPeer(result.current)).toBe(photo));
    act(() => mocks.graphListener?.({ userId: "owner" }));
    expect(showPeer(result.current)).toBeUndefined();
    await waitFor(() => expect(calendarHusshPerson(result.current, "peer@example.test")?.photoUrl).toBeNull());
    expect(calendarHusshPerson(result.current, "owner@example.test")?.photoUrl).toBe(photo);
    expect(mocks.listConnections).toHaveBeenCalledTimes(2);
  });
});
