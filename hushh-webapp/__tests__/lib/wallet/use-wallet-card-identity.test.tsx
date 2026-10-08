import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, vault, getCard, getSummary } = vi.hoisted(() => ({
  auth: { user: null as unknown },
  vault: { vaultKey: "key" as string | null, getVaultOwnerToken: vi.fn(() => "owner-token") },
  getCard: vi.fn(),
  getSummary: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("@/lib/services/wallet-card-service", () => ({ WalletCardService: { getCard } }));
vi.mock("@/lib/services/referral-service", () => ({ ReferralService: { getSummary } }));

import { useWalletCardIdentity } from "@/lib/wallet/use-wallet-card-identity";

function account(uid: string, displayName: string | null, creationTime: string | undefined) {
  return { uid, displayName, metadata: { creationTime }, getIdToken: vi.fn(async () => `token-${uid}`) };
}

const ADA = account("ada", "Ada Lovelace", "Thu, 05 Mar 2026 10:00:00 GMT");
const BEN = account("ben", "Ben Franklin", "Mon, 04 Jan 2027 10:00:00 GMT");

function serverFor(uid: string) {
  getCard.mockImplementation(async ({ userId }: { userId: string }) => ({
    enabled: true,
    exists: true,
    card: { cardPayload: { full_name: `${userId} Saved Name` }, displayName: null },
    shareUrl: `https://one.hushh.ai/c/${userId}-profile`,
  }));
  getSummary.mockImplementation(async () => ({ link: `https://one.hushh.ai/r/${uid}-ref` }));
}

describe("useWalletCardIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = ADA;
    vault.vaultKey = "key";
    vault.getVaultOwnerToken.mockReturnValue("owner-token");
    serverFor("ada");
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
      referralUrl: null,
    });
    await waitFor(() => expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ada-ref"));
    expect(result.current).toMatchObject({
      name: "ada Saved Name",
      profileUrl: "https://one.hushh.ai/c/ada-profile",
    });
    expect(getSummary).toHaveBeenCalledWith({ idToken: "token-ada" });
  });

  it("never shows the previous account's details after logout or an account switch", async () => {
    const { result, rerender } = renderHook(() => useWalletCardIdentity());
    await waitFor(() => expect(result.current.profileUrl).toBe("https://one.hushh.ai/c/ada-profile"));

    // Logout: everything clears at once.
    auth.user = null;
    rerender();
    expect(result.current).toEqual({
      ownerId: null,
      name: null,
      memberSince: null,
      validThru: null,
      profileUrl: null,
      referralUrl: null,
    });

    // Switch to Ben while his data is still loading: none of Ada's leaks through.
    serverFor("ben");
    auth.user = BEN;
    rerender();
    expect(result.current).toMatchObject({
      ownerId: "ben",
      name: "Ben Franklin",
      memberSince: "2027",
      validThru: "12/29",
      profileUrl: null,
      referralUrl: null,
    });
    await waitFor(() => expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ben-ref"));
    expect(result.current.profileUrl).toBe("https://one.hushh.ai/c/ben-profile");
  });

  it("drops a slow answer for the old account that lands after the switch", async () => {
    let releaseAda!: (value: unknown) => void;
    getSummary.mockImplementationOnce(() => new Promise((resolve) => { releaseAda = resolve; }));
    const { result, rerender } = renderHook(() => useWalletCardIdentity());

    serverFor("ben");
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

  it("falls back to the account name and no profile QR while the vault is locked", async () => {
    vault.vaultKey = null;
    vault.getVaultOwnerToken.mockReturnValue(null as never);
    const { result } = renderHook(() => useWalletCardIdentity());
    await waitFor(() => expect(result.current.referralUrl).toBe("https://one.hushh.ai/r/ada-ref"));
    expect(getCard).not.toHaveBeenCalled();
    expect(result.current.name).toBe("Ada Lovelace");
    expect(result.current.profileUrl).toBeNull();
  });
});
