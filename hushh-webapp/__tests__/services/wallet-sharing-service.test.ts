import { describe, it, expect, vi } from "vitest";
import { ConsentCenterService, type ConsentCenterEntry } from "@/lib/services/consent-center-service";
import { loadWalletSharing, walletSharingEntries, walletSharingKind } from "@/lib/services/wallet-sharing-service";

vi.mock("@/lib/services/consent-center-service", () => ({ ConsentCenterService: { listEntries: vi.fn() } }));
const row = (id: string, scope: string): ConsentCenterEntry => ({ id, scope, kind: "incoming_request", status: "pending", action: "request", counterpart_type: "person" });
describe("Wallet sharing projection", () => {
  it("accepts only the two authored Wallet scopes and preserves mixed-bundle identity", () => {
    expect(walletSharingKind(row("x", "attr.wallet.secrets.*"))).toBe("details");
    expect(walletSharingKind(row("x", "attr.wallet.summary.last4"))).toBeNull();
    expect(walletSharingKind(row("x", "agent.wallet.manage"))).toBeNull();
    const wallet = { ...row("wallet", "attr.wallet.summary.*"), bundle_id: "mixed" };
    const mixed = { ...row("other", "attr.location.*"), bundle_items: [{ request_id: "wallet", label: "Wallet", status: "pending", entry: wallet }] };
    expect(walletSharingEntries([mixed, wallet])).toEqual([wallet]);
  });
  it("finds Wallet requests on later pages without treating unrelated grants as Wallet access", async () => {
    vi.mocked(ConsentCenterService.listEntries).mockImplementation(async ({ surface, page }) => ({
      user_id: "owner", actor: "investor", surface, query: "", page: page!, limit: 50, total: 2,
      has_more: surface === "pending" && page === 1,
      items: [row(`${surface}-${page}`, surface === "pending" && page === 2 ? "attr.wallet.summary.*" : "attr.location.*")],
    }));
    const result = await loadWalletSharing({ userId: "owner", idToken: "test", cancelled: () => false });
    expect(result.requests.map((entry) => entry.id)).toEqual(["pending-2"]);
    expect(result.grants).toEqual([]);
  });
  it("rejects another owner's response", async () => {
    vi.mocked(ConsentCenterService.listEntries).mockResolvedValue({ user_id: "other" } as never);
    await expect(loadWalletSharing({ userId: "owner", idToken: "test", cancelled: () => false })).rejects.toThrow("Consent owner changed");
  });
  it("reports incomplete bundles without guessing their scope from labels", async () => {
    vi.mocked(ConsentCenterService.listEntries).mockImplementation(async ({ surface, page }) => ({
      user_id: "owner", actor: "investor", surface, query: "", page: page!, limit: 50, total: 1, has_more: false,
      items: [{ ...row("partial", ""), bundle_complete: false, bundle_label: "Wallet" }],
    }));
    const result = await loadWalletSharing({ userId: "owner", idToken: "test", cancelled: () => false });
    expect(result.incompleteRequests).toBe(true);
    expect(result.requests).toEqual([]);
  });
});
