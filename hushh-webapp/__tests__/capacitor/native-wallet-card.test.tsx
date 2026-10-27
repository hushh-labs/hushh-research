import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NativeRouteAdd, NativeRouteAddSeat } from "@/components/app-ui/native-route-add";
import { NativeWalletCardFence, type NativeWalletCardProjection } from "@/lib/capacitor/native-wallet-card";
const profile = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => profile.pathname }));
// Test registration and action ownership; the real native renderer has its
// existing Chrome suite and physical admission/retirement journey.
vi.mock("@/components/app-ui/native-add-action", () => ({
  NativeAddAction: ({ label, enabled, onActivate }: { label: string; enabled: boolean; onActivate: () => void }) =>
    <button aria-label={label} disabled={!enabled} onClick={onActivate} />,
}));
afterEach(cleanup);

describe("authored native route actions", () => {
  it("removes Wallet Add when a retained Wallet owner observes another route", async () => {
    const bootstrap = Object.getOwnPropertyDescriptor(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__");
    const previousPath = profile.pathname, previousUrl = window.location.href;
    Object.defineProperty(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", { configurable: true,
      value: { contractVersion: 1, enabled: true, walletCardForms: true } });
    const activate = vi.fn();
    const ui = () => <><NativeRouteAdd route="/one/wallet" owner="public-owner" context="wallet-add" enabled onActivate={activate}>
      <button>Body Add</button></NativeRouteAdd><NativeRouteAddSeat /></>;
    try {
      profile.pathname = "/one/wallet/"; window.history.replaceState(null, "", profile.pathname);
      const view = render(ui());
      fireEvent.click(await screen.findByRole("button", { name: "Add a card" }));
      expect(activate).toHaveBeenCalledTimes(1);
      profile.pathname = "/one"; window.history.replaceState(null, "", profile.pathname);
      view.rerender(ui());
      expect(screen.queryByRole("button", { name: "Add a card" })).toBeNull();
      expect(activate).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      profile.pathname = previousPath; window.history.replaceState(null, "", previousUrl);
      if (bootstrap) Object.defineProperty(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", bootstrap);
      else delete (window as Window & { __HUSHH_NATIVE_DRAWER_BOOTSTRAP__?: unknown }).__HUSHH_NATIVE_DRAWER_BOOTSTRAP__;
    }
  });
});

describe("private route-owned card editor", () => {
  it("rejects obsolete draft bases and consumes a confirmed save only once", async () => {
    const state: NativeWalletCardProjection = {
      documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1, visitId: "public-card-visit",
      updateSequence: 1, privacyGeneration: 0, acknowledgedEditRevision: 0, draftRevision: 2,
      draft: { pan: "", cardholderName: "", expiry: "", network: "auto", issuingRegion: "none", securityCode: "" },
      busy: false, canSave: true, appearance: "light", accentHex: "#007aff", foregroundHex: "#111111",
      networks: [{ id: "auto", label: "Auto-detect", selected: true }], regions: [{ id: "none", label: "Select region", selected: true }],
      collectSecurityCode: true, scanEnabled: true, networkLoading: false,
    };
    const fence = new NativeWalletCardFence(state);
    expect(fence.update(state)).toBe(true);
    const edit = { documentId: state.documentId, ownerEpoch: state.ownerEpoch, ownerGeneration: 1, revision: 1, visitId: state.visitId,
      updateSequence: 1, privacyGeneration: 0, editRevision: 1, baseDraftRevision: 1, composing: false, draft: { ...state.draft } };
    expect(fence.consumeEdit(edit)).toBe(false);
    expect(fence.consumeEdit({ ...edit, baseDraftRevision: 2 })).toBe(true);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(true);
    const { draft: _draft, composing: _composing, baseDraftRevision: _base, ...identity } = edit;
    const action = { ...identity, updateSequence: 2, action: "save" as const, sequence: 1 };
    const confirm = vi.fn().mockResolvedValue({ valid: true });
    expect(await fence.consumeAction(action, confirm, () => true)).toBe(true);
    expect(await fence.consumeAction(action, confirm, () => true)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    fence.retire();
    expect(fence.consumeEdit({ ...edit, baseDraftRevision: 2, editRevision: 2 })).toBe(false);
  });
});

