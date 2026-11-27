import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import {
  advanceLocationChatSetup, beginLocationChatSetup, consumeLocationChatSetup, getLocationChatSetupPhase,
  getPendingLocationChatSetupId, locationChatSetupReturnUrl,
} from "@/lib/agent/location-chat-setup-handoff";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { deleteEncryptedOwnerUiRecords, inspectRawMemoryUiCacheForTests } from "@/lib/storage/encrypted-owner-ui-cache";
import { advanceVaultSessionEpoch, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { LOCATION_SHARING_CONSENT_VERSION } from "@/lib/location/setup-progress";
import { LocationChatSetupJourney } from "@/components/location/setup/location-chat-setup-journey";

const ports = vi.hoisted(() => ({ replace: vi.fn(), getProgress: vi.fn(), owner: "owner", key: "79".repeat(32), unlocked: true }));
vi.mock("next/navigation", () => ({ useRouter: () => ports }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ userId: ports.owner, loading: false }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: ports.unlocked, vaultKey: ports.key, vaultOwnerToken: "owner-token" }) }));
vi.mock("@/lib/location/setup-progress", async (original) => ({
  ...await original<typeof import("@/lib/location/setup-progress")>(), getSetupProgress: ports.getProgress,
}));
vi.mock("@/components/app-ui/hushh-loader", () => ({ HushhLoader: () => <p>Loading</p> }));
vi.mock("@/components/location/setup/location-setup-flow", () => ({
  LocationSetupFlow: ({ onSetupComplete, onSetupSkip }: { onSetupComplete: () => Promise<void>; onSetupSkip: () => void }) => <>
    <button onClick={() => void onSetupComplete().catch(() => undefined)}>Finish sharing setup</button>
    <button onClick={onSetupSkip}>Cancel sharing setup</button>
  </>,
}));

const scope = () => ({ ownerId: ports.owner, vaultKey: ports.key, vaultEpoch: snapshotVaultSessionEpoch() });
const proposal = { id: "00000000-0000-4000-a000-000000000001", conversation: true as const,
  action: "share_live" as const, circles: ["Family"], durationHours: 1 };
const intent = { conversationId: "original-thread", messageId: "original-reply", proposal };
async function begin() {
  const href = await beginLocationChatSetup({ ...scope(), ...intent });
  expect(href).toMatch(/^\/one\/location\?locationChatSetup=[a-f0-9-]+$/);
  return { ...scope(), handoffId: getPendingLocationChatSetupId()! };
}
const Intro = ({ complete, cancel }: { complete: () => Promise<void>; cancel: () => Promise<void> }) => <>
  <button onClick={() => void complete()}>Finish Location tour</button>
  <button onClick={() => void cancel()}>Leave Location tour</button>
</>;
beforeEach(() => {
  ports.owner = "owner";
  ports.unlocked = true;
  publishValidatedAuthSessionOwner(ports.owner);
  ports.replace.mockReset();
  ports.getProgress.mockReset();
});
afterEach(async () => {
  cleanup();
  await deleteEncryptedOwnerUiRecords();
  window.sessionStorage.clear();
  vi.useRealTimers();
});

it("returns to the original thread once after the canonical setup confirms the current terms", async () => {
  const current = await begin();
  expect(JSON.stringify([...inspectRawMemoryUiCacheForTests().values()])).not.toContain("Family");
  expect(JSON.stringify(window.sessionStorage)).not.toContain("original-thread");
  ports.getProgress.mockResolvedValue({ completed: true, consent_version: "old", consent_accepted_at: "earlier" });
  const view = render(<StrictMode><LocationChatSetupJourney handoffId={current.handoffId} Intro={Intro} /></StrictMode>);
  fireEvent.click(await screen.findByText("Finish Location tour"));
  const finish = await screen.findByText("Finish sharing setup");
  await act(async () => { fireEvent.click(finish); });
  expect(ports.replace).not.toHaveBeenCalled();
  view.unmount();
  render(<LocationChatSetupJourney handoffId={current.handoffId} Intro={Intro} />);
  ports.getProgress.mockResolvedValue({ user_id: "owner", completed: true, consent_version: LOCATION_SHARING_CONSENT_VERSION, consent_accepted_at: "now" });
  fireEvent.click(await screen.findByText("Finish sharing setup"));
  await waitFor(() => expect(ports.replace).toHaveBeenCalledWith(`/?locationSetupReturn=${current.handoffId}`));
  const results = await Promise.all([consumeLocationChatSetup(current), consumeLocationChatSetup(current)]);
  expect(results.filter(Boolean)).toEqual([{ ...intent, outcome: "completed" }]);
  expect(await consumeLocationChatSetup(current)).toBeNull();
});

it("returns cancellation for Back, explicit Skip, and re-entry after the original handoff", async () => {
  const abandoned = await begin();
  expect(await consumeLocationChatSetup(abandoned)).toMatchObject({ ...intent, outcome: "cancelled" });
  const current = await begin();
  render(<LocationChatSetupJourney handoffId={current.handoffId} Intro={Intro} />);
  fireEvent.click(await screen.findByText("Leave Location tour"));
  await waitFor(() => expect(ports.replace).toHaveBeenCalledWith(locationChatSetupReturnUrl(current.handoffId)));
  expect(await consumeLocationChatSetup(current)).toMatchObject({ outcome: "cancelled" });
  expect(await getLocationChatSetupPhase(abandoned)).toBeNull();
  expect(ports.getProgress).not.toHaveBeenCalled();
});

it("rejects superseded, expired, other-owner, signed-out and stale-vault handoffs", async () => {
  const old = await begin();
  const current = await begin();
  expect(await consumeLocationChatSetup(old)).toBeNull();
  expect(await consumeLocationChatSetup({ ...current, ownerId: "different" })).toBeNull();
  advanceVaultSessionEpoch();
  expect(await advanceLocationChatSetup(current, "completed")).toBe(false);
  expect(await consumeLocationChatSetup({ ...current, vaultEpoch: snapshotVaultSessionEpoch() })).toBeNull();
  const signedOut = await begin();
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner");
  expect(await consumeLocationChatSetup(signedOut)).toBeNull();
  vi.useFakeTimers();
  const timed = await begin();
  vi.advanceTimersByTime(16 * 60_000);
  expect(await consumeLocationChatSetup(timed)).toBeNull();
  expect(locationChatSetupReturnUrl("https://example.com/other")).toBe("/");
});

it("offers retry and return when progress is unavailable or the vault locks", async () => {
  const current = await begin();
  ports.getProgress.mockRejectedValueOnce(new Error("offline"));
  ports.getProgress.mockResolvedValueOnce({ completed: false });
  const view = render(<LocationChatSetupJourney handoffId={current.handoffId} Intro={Intro} />);
  fireEvent.click(await screen.findByText("Finish Location tour"));
  fireEvent.click(await screen.findByText("Try again"));
  await screen.findByText("Finish sharing setup");
  expect(ports.replace).not.toHaveBeenCalled();
  ports.unlocked = false;
  view.rerender(<LocationChatSetupJourney handoffId={current.handoffId} Intro={Intro} />);
  fireEvent.click(await screen.findByText("Return to Chat"));
  expect(ports.replace).toHaveBeenCalledWith(locationChatSetupReturnUrl(current.handoffId));
  expect(await consumeLocationChatSetup(current)).toMatchObject({ outcome: "cancelled" });
});

it("requires a sealed completion even when the tab pointer says setup finished", async () => {
  const current = await begin();
  const storageKey = window.sessionStorage.key(0)!;
  const marker = JSON.parse(window.sessionStorage.getItem(storageKey)!);
  window.sessionStorage.setItem(storageKey, JSON.stringify({ ...marker, phase: "completed" }));
  expect(await consumeLocationChatSetup(current)).toMatchObject({ outcome: "cancelled" });
});
