import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  userId: "owner" as string | null,
  unlocked: true,
  bootstrap: vi.fn(),
  state: vi.fn(),
  token: () => "vault-token",
  key: () => "vault-key",
}));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ user: ports.userId ? { uid: ports.userId } : null }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: ports.unlocked, getVaultKey: ports.key, getVaultOwnerToken: ports.token }) }));
vi.mock("@/lib/consent/use-consent-pending-summary-count", () => ({ useConsentPendingSummaryCount: () => 0 }));
vi.mock("@/lib/one-location/key-bootstrap", () => ({ bootstrapCurrentUserLocationRecipientKey: ports.bootstrap }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { getState: ports.state } }));
vi.mock("@/lib/testing/native-test", () => ({ shouldSkipReviewerBackgroundWritesForAutomation: () => false }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: { getCachedBootstrapState: () => null, bootstrapState: async () => ({ setupCapabilityIds: [], setupCapabilityDeclinedIds: [] }) } }));
vi.mock("@/lib/services/cache-service", () => ({ CacheService: { getInstance: () => ({ subscribe: () => () => undefined }) }, CACHE_KEYS: { PRE_VAULT_BOOTSTRAP: (id: string) => id } }));
vi.mock("@/lib/services/capability-tour-service", () => ({ CapabilityTourService: { loadExploredIds: async () => [] } }));
vi.mock("@/lib/services/gmail-receipts-service", () => ({ GmailReceiptsService: {} }));
vi.mock("@/lib/services/google-calendar-service", () => ({ GoogleCalendarService: {} }));
vi.mock("@/lib/services/kai-profile-service", () => ({ KaiProfileService: {} }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: {} }));
vi.mock("@/lib/services/ria-service", () => ({ RiaService: {} }));
import { useCapabilitySetupStates } from "@/lib/onboarding/use-capability-setup-states";

const recipient = { keyId: "account-key", publicKeyJwk: { kty: "EC" }, canReceiveLocation: true };
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  ports.userId = "owner";
  ports.unlocked = true;
  ports.bootstrap.mockResolvedValue(recipient);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const settle = async () => { await act(async () => { await Promise.resolve(); }); };

describe("automatic Location readiness after One unlock", () => {
  it("awaits automatic recovery instead of persisting a racing missing-key state", async () => {
    let finish!: (value: unknown) => void;
    ports.bootstrap.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useCapabilitySetupStates());
    await settle();
    expect(result.current.byId.location.state).toBe("unknown");
    expect(result.current.isEnriching).toBe(true);
    expect(ports.state).not.toHaveBeenCalled();
    await act(async () => finish(recipient));
    expect(result.current.byId.location.state).toBe("in-progress");
    expect(result.current.isEnriching).toBe(false);
    expect(ports.bootstrap).toHaveBeenCalledWith({ userId: "owner", vaultOwnerToken: "vault-token", vaultKey: "vault-key", strictRecovery: true });
  });

  it("retries a transient recovery failure without reporting absent onboarding", async () => {
    ports.bootstrap.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useCapabilitySetupStates());
    await settle();
    expect(result.current.byId.location.state).toBe("unknown");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(ports.bootstrap).toHaveBeenCalledTimes(2);
    expect(result.current.byId.location.state).toBe("in-progress");
  });

  it("ignores an old owner's completion and cancels retry on lock", async () => {
    let finish!: (value: unknown) => void;
    ports.bootstrap.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    ports.bootstrap.mockRejectedValueOnce(new Error("offline"));
    const { result, rerender } = renderHook(() => useCapabilitySetupStates());
    await settle();
    ports.userId = "other";
    rerender();
    await settle();
    await act(async () => finish(recipient));
    expect(result.current.byId.location.state).toBe("unknown");
    ports.unlocked = false;
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(ports.bootstrap).toHaveBeenCalledTimes(2);
    expect(result.current.byId.location.state).toBe("unknown");
  });
});
