import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, vault, getCard, getSummary } = vi.hoisted(() => ({
  auth: { user: null as unknown },
  vault: { vaultKey: "key" as string | null, getVaultOwnerToken: vi.fn((): string | null => "owner-token") },
  getCard: vi.fn(),
  getSummary: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("@/lib/services/wallet-card-service", () => ({
  WALLET_CARD_CHANGED_EVENT: "hushh:wallet-card-changed",
  WalletCardService: { getCard },
}));
vi.mock("@/lib/services/referral-service", () => ({ ReferralService: { getSummary } }));

import { useWalletCardIdentity } from "@/lib/wallet/use-wallet-card-identity";

function account(uid: string, displayName: string | null, creationTime: string | undefined) {
  return { uid, displayName, metadata: { creationTime }, getIdToken: vi.fn(async () => `token-${uid}`) };
}

const ADA = account("ada", "Ada Lovelace", "Thu, 05 Mar 2026 10:00:00 GMT");
const BEN = account("ben", "Ben Franklin", "Mon, 04 Jan 2027 10:00:00 GMT");

/** A Wallet Profile that exists and whose link this device holds. */
function profileFor(uid: string) {
  getCard.mockImplementation(async ({ userId }: { userId: string }) => ({
    enabled: true,
    exists: true,
    card: { status: "active", cardPayload: { full_name: `${userId} Saved Name` }, displayName: null },
    shareUrl: `https://one.hushh.ai/c/${userId}-profile`,
  }));
  getSummary.mockImplementation(async () => ({ link: `https://one.hushh.ai/r/${uid}-ref` }));
}

const NO_PROFILE = { enabled: true, exists: false, card: null, shareUrl: null };

describe("useWalletCardIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = ADA;
    vault.vaultKey = "key";
    vault.getVaultOwnerToken.mockReturnValue("owner-token");
    profileFor("ada");
  });

  it("serves one authenticated identity to both cards", async () => {
    const { result } = renderHook(() => useWalletCardIdentity());
    // Dates and a fallback name need no network, so nothing waits on the server.
    expect(result.current).toMatchObject({
      ownerId: "ada",
      name: "Ada Lovelace",
      memberSince: "2026",
      validThru: "12/28",
      profileUrl: null,
      profileStatus: "unknown",
      referralUrl: null,
    });
    await waitFor(() => expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ada-ref"));
    await waitFor(() => expect(result.current.profileStatus).toBe("ready"));
    expect(result.current).toMatchObject({
      name: "ada Saved Name",
      profileUrl: "https://one.hushh.ai/c/ada-profile",
    });
    expect(getSummary).toHaveBeenCalledWith({ idToken: "token-ada" });
  });

  it("never shows the previous account's details after logout or an account switch", async () => {
    const { result, rerender } = renderHook(() => useWalletCardIdentity());
    await waitFor(() => expect(result.current.profileUrl).toBe("https://one.hushh.ai/c/ada-profile"));
    await waitFor(() => expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ada-ref"));

    // Logout: everything clears at once.
    auth.user = null;
    rerender();
    expect(result.current).toEqual({
      ownerId: null,
      name: null,
      memberSince: null,
      validThru: null,
      profileUrl: null,
      profileStatus: "unknown",
      referralUrl: null,
    });

    // Switch to Ben while his data is still loading: none of Ada's leaks through.
    profileFor("ben");
    auth.user = BEN;
    rerender();
    expect(result.current).toMatchObject({
      ownerId: "ben",
      name: "Ben Franklin",
      memberSince: "2027",
      validThru: "12/29",
      profileUrl: null,
      profileStatus: "unknown",
      referralUrl: null,
    });
    await waitFor(() => expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ben-ref"));
    await waitFor(() => expect(result.current.profileUrl).toBe("https://one.hushh.ai/c/ben-profile"));
  });

  it("drops a slow answer for the old account that lands after the switch", async () => {
    let releaseAda!: (value: unknown) => void;
    getSummary.mockImplementationOnce(() => new Promise((resolve) => { releaseAda = resolve; }));
    const { result, rerender } = renderHook(() => useWalletCardIdentity());

    profileFor("ben");
    auth.user = BEN;
    rerender();
    await waitFor(() => expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ben-ref"));

    await act(async () => releaseAda({ link: "https://one.hushh.ai/r/ada-ref" }));
    expect(result.current.ownerId).toBe("ben");
    expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ben-ref");
  });

  it("leaves 'member since' empty when Firebase gives no creation time, never today's year", () => {
    auth.user = account("ada", "Ada Lovelace", undefined);
    const { result } = renderHook(() => useWalletCardIdentity());
    expect(result.current.memberSince).toBeNull();
    expect(result.current.validThru).toBeNull();
  });

  describe("Wallet Profile status", () => {
    it("reports 'setup' only when the server says there is no active profile", async () => {
      getCard.mockResolvedValue(NO_PROFILE);
      const { result } = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(result.current.profileStatus).toBe("setup"));
      expect(result.current.profileUrl).toBeNull();
      // The gold card is unaffected by there being no profile.
      await waitFor(() => expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ada-ref"));
    });

    it("treats a revoked profile as needing setup", async () => {
      getCard.mockResolvedValue({ enabled: true, exists: true, card: { status: "revoked", cardPayload: {}, displayName: null }, shareUrl: null });
      const { result } = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(result.current.profileStatus).toBe("setup"));
    });

    it("keeps an existing profile as 'link-missing', not 'setup', when this device has no stored link", async () => {
      getCard.mockResolvedValue({ enabled: true, exists: true, card: { status: "active", cardPayload: { full_name: "Ada L" }, displayName: null }, shareUrl: null });
      const { result } = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(result.current.profileStatus).toBe("link-missing"));
      expect(result.current.profileUrl).toBeNull();
    });

    it("never calls a failed request, a locked vault or a disabled feature 'setup'", async () => {
      getCard.mockRejectedValue(new Error("offline"));
      const failed = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(getSummary).toHaveBeenCalled());
      await waitFor(() => expect(getCard).toHaveBeenCalled());
      expect(failed.result.current.profileStatus).toBe("unknown");
      failed.unmount();

      getCard.mockClear();
      vault.vaultKey = null;
      vault.getVaultOwnerToken.mockReturnValue(null);
      const locked = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(locked.result.current.referralUrl).toBe("https://one.hushh.ai/r/ada-ref"));
      expect(getCard).not.toHaveBeenCalled();
      expect(locked.result.current).toMatchObject({ profileStatus: "unknown", name: "Ada Lovelace", profileUrl: null });
      locked.unmount();

      vault.vaultKey = "key";
      vault.getVaultOwnerToken.mockReturnValue("owner-token");
      getCard.mockResolvedValue({ enabled: false, exists: false, card: null, shareUrl: null });
      const disabled = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(getCard).toHaveBeenCalled());
      expect(disabled.result.current.profileStatus).toBe("unknown");
    });

    it("keeps the last known status when a later refresh fails", async () => {
      getCard.mockResolvedValueOnce(NO_PROFILE);
      const { result } = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(result.current.profileStatus).toBe("setup"));

      getCard.mockRejectedValue(new Error("offline"));
      await act(async () => window.dispatchEvent(new Event("hushh:wallet-card-changed")));
      await waitFor(() => expect(getCard).toHaveBeenCalledTimes(2));
      expect(result.current.profileStatus).toBe("setup");
    });

    it("swaps the setup state for the real QR as soon as a profile is created, without a reload", async () => {
      getCard.mockResolvedValueOnce(NO_PROFILE);
      const { result } = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(result.current.profileStatus).toBe("setup"));

      profileFor("ada"); // setup completed elsewhere in the app
      await act(async () => window.dispatchEvent(new Event("hushh:wallet-card-changed")));
      await waitFor(() => expect(result.current.profileStatus).toBe("ready"));
      expect(result.current.profileUrl).toBe("https://one.hushh.ai/c/ada-profile");
    });
  });

  describe("Invite friends link", () => {
    it("loads without the vault, without a profile and after a failed first try", async () => {
      vault.vaultKey = null;
      vault.getVaultOwnerToken.mockReturnValue(null);
      getSummary.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ link: "https://one.hushh.ai/r/ada-ref" });
      const { result } = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(1));
      expect(result.current.referralUrl).toBeNull();

      await act(async () => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ada-ref"));
    });

    it("is requested once per owner, not on every refresh", async () => {
      const { result } = renderHook(() => useWalletCardIdentity());
      await waitFor(() => expect(result.current.referralUrl).not.toBeNull());
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("hushh:wallet-card-changed"));
      });
      expect(getSummary).toHaveBeenCalledTimes(1);
    });
  });
});
