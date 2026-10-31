import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PkmSharingPriceReview } from "@/components/profile/pkm-sharing-price-review";
import { resolveLocalOnboardingHandler, type LocalOnboardingActionResult } from "@/lib/agent/local-onboarding-actions";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { resolveNavigationJourney } from "@/lib/kai/actions/navigation-journey";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

const mocks = vi.hoisted(() => ({
  user: { uid: "owner", getIdToken: async () => "synthetic-token" },
  vault: { isVaultUnlocked: true, vaultOwnerToken: "synthetic-vault-token", tokenExpiresAt: 0 },
  metadata: vi.fn(), manifest: vi.fn(), scopes: vi.fn(), exposure: vi.fn(), editor: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, userId: mocks.user.uid, loading: false, sessionVerificationRequired: false }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ ...mocks.vault, getVaultOwnerToken: () => mocks.vault.vaultOwnerToken }) }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: { getMetadata: mocks.metadata, getDomainManifest: mocks.manifest, getAvailableScopes: mocks.scopes, updateScopeExposure: mocks.exposure } }));
vi.mock("@/components/consent/scope-tariff-editor", () => ({ ScopeTariffEditor: (props: { label: string }) => { mocks.editor(props); return <div role="dialog">{props.label}</div>; } }));

const ACTION = "pkm.review_sharing_price";
function manifest(version = 7, second = false) {
  const entry = (path: string, label: string) => ({ scope_handle: `scope_${path}`, scope_label: label,
    summary_projection: { top_level_scope_path: path, materialization_state: "materialized", materialized_leaf_count: 2 } });
  return { domain: "food", user_id: mocks.user.uid, manifest_version: version, scope_registry: [entry("preferences", "Food preferences"), ...(second ? [entry("allergies", "Allergies")] : [])] };
}
async function run(slots: Record<string, unknown>, context = {}) {
  let result: LocalOnboardingActionResult | undefined;
  await act(async () => { result = await resolveLocalOnboardingHandler(ACTION)!(slots, context); });
  return result!;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { uid: "owner", getIdToken: async () => "synthetic-token" };
  mocks.vault = { isVaultUnlocked: true, vaultOwnerToken: "synthetic-vault-token", tokenExpiresAt: Date.now() + 60_000 };
  publishValidatedAuthSessionOwner("owner");
  mocks.metadata.mockImplementation(async () => ({ userId: mocks.user.uid, domains: [{ key: "food", summary: {} }] }));
  mocks.manifest.mockResolvedValue(manifest());
  mocks.scopes.mockImplementation(async () => ({ userId: mocks.user.uid, scopeEntries: [] }));
});
afterEach(cleanup);

describe("owner-bound chat sharing price review", () => {
  it("uses the authored navigation journey and fresh exact section for review-only prefill", async () => {
    expect(resolveNavigationJourney(ACTION)).toMatchObject({ destinationRoute: "/one/pkm", navigationActionId: "route.one_pkm" });
    render(<PkmSharingPriceReview />);
    const result = await run({ section: "Food preferences", proposed_price_cents: "1", proposed_base_hours: "24" });
    expect(result).toMatchObject({ status: "succeeded", summary: "Sharing price review opened; nothing saved." });
    expect(mocks.metadata).toHaveBeenCalledWith("owner", true, "synthetic-vault-token", { allowStaleFallback: false });
    expect(mocks.manifest).toHaveBeenCalledWith("owner", "food", "synthetic-vault-token", true);
    expect(mocks.editor.mock.calls.at(-1)?.[0]).toMatchObject({ scopeHandle: "scope_preferences", machineScope: "attr.food.preferences.*", reviewRequest: { proposedPriceCents: 1, proposedBaseHours: 24 } });
    expect((await run({ section: "Food preferences" })).status).toBe("blocked");
  });

  it("never broadens a leaf, re-reads a selected choice, and refuses stale or foreign choices", async () => {
    render(<PkmSharingPriceReview />);
    mocks.metadata.mockResolvedValue({ userId: "owner", domains: [{ key: "food", summary: {} }, { key: "work", summary: {} }] });
    mocks.manifest.mockImplementation(async (_owner, domain) => domain === "work" ? { ...manifest(), domain: "work", scope_registry: [] } : manifest());
    expect((await run({ domain: "work", section: "Food preferences" })).status).toBe("blocked");
    expect(mocks.editor).not.toHaveBeenCalled();
    mocks.metadata.mockResolvedValue({ userId: "owner", domains: [{ key: "food", summary: {} }] });
    mocks.manifest.mockResolvedValue(manifest());
    expect((await run({ section: "attr.food.preferences.spice" })).status).toBe("blocked");
    expect(mocks.editor).not.toHaveBeenCalled();
    mocks.manifest.mockResolvedValue(manifest(7, true));
    const result = await run({ proposed_price_cents: "0" });
    const selection = (result.data?.disambiguation as { candidates: { id: string }[] }).candidates[0]!.id;
    mocks.manifest.mockResolvedValue(manifest(8, true));
    expect((await run({ scope_choice: selection })).status).toBe("blocked");
    expect(mocks.editor).not.toHaveBeenCalled();
    expect((await run({ scope_choice: "foreign-choice" })).status).toBe("blocked");
    const fresh = await run({ proposed_price_cents: "0" });
    const choice = (fresh.data?.disambiguation as { candidates: { id: string }[] }).candidates[0]!.id;
    expect((await run({ scope_choice: choice, proposed_price_cents: "0" })).status).toBe("succeeded");
    expect(mocks.editor.mock.calls.at(-1)?.[0]).toMatchObject({ reviewRequest: { proposedPriceCents: 0 } });
  });

  it("offers a whole bundle only from current owner discovery and opens domain listing without writes", async () => {
    mocks.scopes.mockResolvedValue({ userId: "owner", scopeEntries: [{ scope: "attr.food.*", scope_handle: "s_food_bundle", domain: "food", path: null,
      wildcard: true, consumer_visible: true, materialization_state: "materialized" }] });
    const { unmount } = render(<PkmSharingPriceReview />);
    expect((await run({ section: "food", proposed_price_cents: 1 })).status).toBe("succeeded");
    expect(mocks.editor.mock.calls.at(-1)?.[0]).toMatchObject({ scopeHandle: "s_food_bundle", machineScope: "attr.food.*" });
    unmount(); cleanup(); mocks.editor.mockClear();
    const overview = render(<PkmSharingPriceReview />);
    expect((await run({ domain: "food", proposed_base_hours: 24 })).status).toBe("succeeded");
    await waitFor(() => expect(mocks.editor.mock.calls.some(([props]) => props.machineScope === "attr.food.*" && props.reviewRequest?.proposedBaseHours === 24)).toBe(true));
    const wholeEditor = mocks.editor.mock.calls.find(([props]) => props.machineScope === "attr.food.*" && props.reviewRequest?.proposedBaseHours === 24)![0];
    await act(async () => { expect(wholeEditor.onPaymentsNavigate()).toBe(true); });
    expect(screen.queryByRole("dialog")).toBeNull();
    overview.unmount(); cleanup(); mocks.editor.mockClear();
    mocks.scopes.mockResolvedValue({ userId: "owner", scopeEntries: [] });
    render(<PkmSharingPriceReview />);
    expect((await run({ section: "food" })).status).toBe("blocked");
    expect(mocks.editor).not.toHaveBeenCalled();
    expect((await run({ domain: "food" })).status).toBe("succeeded");
    expect(await screen.findByRole("dialog", { name: /food: sharing and price/i })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Make private Food preferences" })).toBeVisible();
    expect(mocks.exposure).not.toHaveBeenCalled();
    expect(screen.queryByText("Whole bundle price")).toBeNull();
    act(() => { expect(unwindBackLayer("/one/pkm")).toBe(true); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["owner", "vault", "expiry"])("refuses a late manifest after %s retirement", async retirement => {
    let settle!: (value: ReturnType<typeof manifest>) => void;
    mocks.manifest.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    const { rerender } = render(<PkmSharingPriceReview />);
    const originalManifest = manifest();
    const pending = resolveLocalOnboardingHandler(ACTION)!({ section: "Food preferences" });
    await waitFor(() => expect(mocks.manifest).toHaveBeenCalled());
    act(() => {
      if (retirement === "owner") { publishValidatedAuthSessionOwner("other"); mocks.user = { ...mocks.user, uid: "other" }; }
      if (retirement === "vault") advanceVaultSessionEpoch();
      if (retirement === "expiry") mocks.vault = { ...mocks.vault, tokenExpiresAt: Date.now() - 1 };
      rerender(<PkmSharingPriceReview />);
    });
    let result: LocalOnboardingActionResult | undefined;
    await act(async () => { settle(originalManifest); result = await pending; });
    expect(result?.status).toBe("blocked");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.editor).not.toHaveBeenCalled();
  });

  it("rejects malformed proposals and mismatched owner manifests without opening an editor", async () => {
    render(<PkmSharingPriceReview />);
    for (const slots of [{ proposed_price_cents: "1.5" }, { proposed_price_cents: "100001" }, { proposed_price_cents: -1 }, { proposed_base_hours: "1" }]) {
      expect((await run({ section: "Food preferences", ...slots })).status).toBe("blocked");
    }
    expect(mocks.manifest).not.toHaveBeenCalled();
    mocks.manifest.mockResolvedValue({ ...manifest(), user_id: "foreign" });
    expect((await run({ section: "Food preferences" })).status).toBe("blocked");
    expect(mocks.editor).not.toHaveBeenCalled();
  });
});
