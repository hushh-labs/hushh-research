import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NativeChromeLease, chromeOwnerEpoch, canResumeNativeChrome, suspendOwnedNativeChrome, getNativeChromeCapabilities, peekNativeChromeCapabilities, hasOutstandingNativeChrome, retireNativeChrome, retireOwnedNativeChrome, syncNativeCanvasAppearance, type ChromeAcknowledgement, type ChromeProjection, type ChromeUpdateAcknowledgement } from "@/lib/capacitor/native-chrome";
import { NativeShellBack } from "@/components/app-ui/native-shell-back";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";
import { projectNativeLegalDocument } from "@/lib/capacitor/native-profile-legal";
import { projectNativeProfileLegal } from "@/components/profile/profile-native-legal";
import { NativeChatChrome, NativeHistoryClose, NativeHistoryOpener, type NativeChatChromeHandle } from "@/components/app-ui/native-chat-chrome";
import { ProfilePane } from "@/components/app-ui/profile-pane";
import { nativeShellOverlayBlocked, useNativeNavigationBlocked } from "@/lib/capacitor/native-navigation";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";
import { writeAccent } from "@/lib/theme/accent";
import { isCurrentNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { DockEventFence, nativeDockRestingFrame, type DockEvent, type DockState } from "@/lib/capacitor/native-dock";
import { NativeDrawerChoiceFence, validNativeConnectorPath, validNativeDrawerProjection, nativeDrawerIsolation, subscribeNativeDrawerIsolation, type NativeDrawerProjection, type NativeDrawerChoice, type NativeDrawerIsolation, type NativeDrawerReadmission, type HushhNativeDrawersPlugin } from "@/lib/capacitor/native-drawers";
import { NativeDrawerPresentation } from "@/lib/capacitor/native-drawer-presentation";
import type { NativeDrawerPresentationState } from "@/lib/capacitor/native-drawers";
import { nativeDrawerChoiceAllowed, nativeDrawersPlatformEligible, nativeDrawers, nativeWorkspaceRetirementBarrier, trackNativeWorkspaceRetirement } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { NativeAgentDock } from "@/components/agent/native-agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { NativePanelPoseWriter, useNativePanelPresentation, type NativePanelPose } from "@/lib/capacitor/native-panel-presentation";
import { nativePresentationAdmission, registerNativeDrawerPose, setNativePresentationRegionIsolation, syncNativePresentationRegions, useNativeFullWindowOverlayReady, waitForNativeDrawerCoverageRelease, type NativePresentationRegions } from "@/lib/capacitor/native-presentation-regions";
import { AgentDockPortal, AgentDockProvider, useAgentDockState } from "@/components/agent/agent-dock";
import { useNativeDockPort, useNativeDockPorts, type NativeDockPort } from "@/components/agent/native-dock-port";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { setNativeBaseAperture } from "@/lib/capacitor/native-base-apertures";
import { NativeProfilePresentation, projectNativeProfileMenu } from "@/components/profile/native-profile-menu";
import { profileMenuGroups, type ProfileMenuActions } from "@/components/profile/profile-menu-model";
import { useNativeDrawerPresentation } from "@/lib/capacitor/use-native-drawer-presentation";
import { NativeProfileNameFence, validNativeProfileNameProjection, type NativeProfileNameProjection } from "@/lib/capacitor/native-profile-name-scene";
import { NativeWorldModelFence, validNativeWorldModelProjection, type NativeWorldModelProjection, type WorldModelForm } from "@/lib/capacitor/native-profile-world-model-scene";
import { NativeRuntimeFence, validNativeRuntimeProjection, validNativeRuntimeFinalEdit, type NativeRuntimeProjection } from "@/lib/capacitor/native-profile-runtime-scene";
import { NativeConnectorFence, validNativeConnectorProjection, validNativeConnectorFinalEdit, type NativeConnectorProjection } from "@/lib/capacitor/native-profile-connector-scene";
import { NativeMemoryFence, validNativeMemoryProjection, validNativeMemoryFinalEdit, type NativeMemoryProjection } from "@/lib/capacitor/native-profile-memory-scene";
import { NativePasswordFence, validNativePasswordProjection, type NativePasswordProjection } from "@/lib/capacitor/native-profile-password-scene";
import { NativeProfileNamePresentation } from "@/lib/capacitor/native-profile-name-presentation";
import { NativeProfileStyleFence, STYLE_CHOICE_OPTIONS, validNativeProfileStyleProjection, type NativeProfileStyleProjection } from "@/lib/capacitor/native-profile-style-scene";
import { NativeProfileScenePresentation } from "@/lib/capacitor/native-profile-scene-presentation";
import { NativePhoneFence, validNativePhoneProjection, type NativePhoneProjection } from "@/lib/capacitor/native-profile-phone-scene";
import { NativePhoneVerificationFlow } from "@/components/profile/native-phone-verification-flow";
import { NativeRequestPricingEditor } from "@/components/profile/native-request-pricing";
import { NativeVaultPasswordEditor } from "@/components/profile/native-vault-password-editor";
import { registerBackLayer } from "@/lib/navigation/back-layers";
import { backProfilePane } from "@/lib/navigation/profile-pane-back";
import { validNativeWorkspace, workspaceAcknowledged, type NativeWorkspaceProjection } from "@/lib/capacitor/native-workspace";
import { useNativeWorkspace } from "@/lib/capacitor/use-native-workspace";

describe("private route-body presentation boundary", () => {
  it("keeps an uncertain route retirement fenced until exact native absence is read back", async () => {
    const identity = { documentId: "public-retirement-document", ownerEpoch: "public-retirement-owner",
      ownerGeneration: 1, revision: 1, workspace: "referrals" as const };
    const receipt = { ...identity, updateSequence: 0, privacyGeneration: 0, layoutRevision: 0,
      phase: "retired" as const, settled: true };
    const source = { getWorkspaceState: vi.fn().mockResolvedValue({ valid: false }) };
    trackNativeWorkspaceRetirement(identity, Promise.resolve(false), source);
    try {
      await Promise.resolve();
      expect(await nativeWorkspaceRetirementBarrier()).toBe(false);
      source.getWorkspaceState.mockResolvedValue({ ...receipt, ownerEpoch: "other-owner" });
      expect(await nativeWorkspaceRetirementBarrier()).toBe(false);
      source.getWorkspaceState.mockResolvedValue(receipt);
      expect(await nativeWorkspaceRetirementBarrier()).toBe(true);
      expect(nativeWorkspaceRetirementBarrier()).toBeUndefined();
      expect(source.getWorkspaceState).toHaveBeenCalledTimes(3);
    } finally {
      source.getWorkspaceState.mockResolvedValue(receipt);
      await nativeWorkspaceRetirementBarrier();
    }
  });
  it("waits for route-body disappearance before reopening a retained Profile drawer", async () => {
    const bootstrap = Object.getOwnPropertyDescriptor(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__");
    Object.defineProperty(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", { configurable: true,
      value: { contractVersion: 1, enabled: true, coherentShell: true } });
    vi.mocked(customNativePresentationEnabled).mockReturnValue(true);
    publishValidatedAuthSessionOwner("synthetic-return-owner");
    bridge.documentId = crypto.randomUUID();
    privacy.state = { generation: 0, shielded: false, appIsActive: true, cause: "inactive" };
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    const originalObserver = globalThis.ResizeObserver;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 100, width: window.innerWidth, height: 400 } as DOMRect);
    drawerBridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true,
      wholePresentation: true, routeWorkspaces: ["referrals"], ...nativeDrawerIsolation() });
    const retirement = deferred<unknown>();
    let absent = false;
    drawerBridge.retireWorkspace.mockReset().mockImplementation(() => retirement.promise);
    drawerBridge.applyWorkspace.mockReset().mockImplementation(async state => ({ ...state,
      layoutRevision: state.frame.layoutRevision, phase: "active", settled: true }));
    drawerBridge.apply.mockReset().mockImplementation(async state => {
      if (state.open && !absent) throw new Error("NATIVE_DRAWER_RETIRING");
      return { ...state, phase: "active" };
    });
    drawerBridge.retire.mockImplementation(async identity => ({ ...identity, updateSequence: 1,
      privacyGeneration: 0, phase: "retired" }));
    function Workspace() {
      const phase = useNativeWorkspace({ owner: "synthetic-return-owner", current: () => true, back: () => {},
        content: { workspace: "referrals", page: "overview", title: "Public workspace", enabled: true,
          backEnabled: false, sections: [] }, actions: new Map() });
      return <div data-native-workspace-seat="true"><output data-testid="workspace-phase">{phase}</output></div>;
    }
    function Profile({ open }: { open: boolean }) {
      const phase = useNativeDrawerPresentation({ family: "profile", owner: "synthetic-return-owner",
        vaultEpoch: snapshotVaultSessionEpoch(), ready: true, open, title: "Profile",
        project: () => ({ sections: [], actions: { rows: new Map(), open: () => {}, close: () => {} } }) });
      return <output data-testid="profile-phase">{phase}</output>;
    }
    function Journey() {
      const [returned, setReturned] = useState(false);
      return <>{!returned && <Workspace />}<Profile open={returned} />
        <button onClick={() => setReturned(true)}>Return to Profile</button></>;
    }
    const view = render(<Journey />);
    try {
      await waitFor(() => expect(view.getByTestId("workspace-phase")).toHaveTextContent("native"));
      await waitFor(() => expect(view.getByTestId("profile-phase")).toHaveTextContent("native"));
      await act(async () => { fireEvent.click(view.getByRole("button", { name: "Return to Profile" })); });
      expect(drawerBridge.retireWorkspace).toHaveBeenCalledOnce();
      expect(drawerBridge.apply.mock.calls.filter(([state]) => state.open)).toHaveLength(0);
      const identity = drawerBridge.retireWorkspace.mock.calls[0][0];
      absent = true;
      await act(async () => { retirement.resolve({ ...identity, phase: "retired", settled: true }); });
      await waitFor(() => expect(drawerBridge.apply.mock.calls.filter(([state]) => state.open)).toHaveLength(1));
      await waitFor(() => expect(view.getByTestId("profile-phase")).toHaveTextContent("native"));
    } finally {
      absent = true;
      retirement.resolve({ ...drawerBridge.retireWorkspace.mock.calls[0]?.[0], phase: "retired", settled: true });
      view.unmount();
      await act(async () => { await Promise.resolve(); });
      measure.mockRestore(); vi.stubGlobal("ResizeObserver", originalObserver);
      publishValidatedAuthSessionOwner(null);
      if (bootstrap) Object.defineProperty(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", bootstrap);
      else Reflect.deleteProperty(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__");
    }
  });
  it("rejects a delayed confirmation after content changes and consumes the new choice once", async () => {
    publishValidatedAuthSessionOwner("synthetic-workspace-owner");
    bridge.documentId = crypto.randomUUID();
    privacy.state = { generation: 0, shielded: false, appIsActive: true, cause: "inactive" };
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    const seat = document.createElement("div"); seat.dataset.nativeWorkspaceSeat = "true"; document.body.append(seat);
    vi.spyOn(seat, "getBoundingClientRect").mockReturnValue({ x: 0, y: 100, width: window.innerWidth, height: 400 } as DOMRect);
    const originalObserver = globalThis.ResizeObserver;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    drawerBridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true, wholePresentation: true, routeWorkspaces: ["referrals"], ...nativeDrawerIsolation() });
    drawerBridge.applyWorkspace.mockImplementation(async state => ({ ...state, layoutRevision: state.frame.layoutRevision, phase: "active", settled: true }));
    drawerBridge.retireWorkspace.mockImplementation(async state => ({ ...state, updateSequence: 0, privacyGeneration: 0, layoutRevision: 0, phase: "retired", settled: true }));
    let confirm!: (value: { valid: boolean }) => void;
    drawerBridge.confirmWorkspaceChoice.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    drawerBridge.settleWorkspaceChoice.mockResolvedValue({ valid: true });
    const action = vi.fn();
    function Workspace() {
      const [value, setValue] = useState("old");
      const phase = useNativeWorkspace({ owner: "synthetic-workspace-owner", current: () => true, back: () => {},
        content: { workspace: "referrals", page: "overview", title: "Synthetic workspace", enabled: true, backEnabled: false,
          sections: [{ id: "public-section", rows: [{ id: "public-action", label: value, enabled: true }] }] },
        actions: new Map([["public-action", () => action(value)]]) });
      return <><output>{phase}</output><button onClick={() => setValue("new")}>Change content</button></>;
    }
    const view = render(<Workspace />);
    const emit = (state: NativeWorkspaceProjection, sequence: number) => act(() => {
      const { documentId, ownerEpoch, ownerGeneration, revision, workspace, updateSequence, privacyGeneration } = state;
      drawerBridge.listeners.get("workspaceChoice")?.forEach(callback => callback({ documentId, ownerEpoch, ownerGeneration, revision, workspace, updateSequence, privacyGeneration, sequence, action: "row", rowId: "public-action" }));
    });
    try {
      await waitFor(() => expect(view.getByText("native")).toBeInTheDocument());
      const before = drawerBridge.applyWorkspace.mock.calls.at(-1)![0];
      emit(before, 1);
      await waitFor(() => expect(drawerBridge.confirmWorkspaceChoice).toHaveBeenCalledOnce());
      fireEvent.click(view.getByRole("button", { name: "Change content" }));
      await waitFor(() => expect(drawerBridge.applyWorkspace.mock.calls.at(-1)![0].updateSequence).toBeGreaterThan(before.updateSequence));
      await act(async () => { confirm({ valid: true }); });
      await waitFor(() => expect(drawerBridge.settleWorkspaceChoice).toHaveBeenCalledOnce());
      expect(action).not.toHaveBeenCalled();
      drawerBridge.confirmWorkspaceChoice.mockResolvedValue({ valid: true });
      const after = drawerBridge.applyWorkspace.mock.calls.at(-1)![0];
      emit(after, 2);
      await waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith("new"));
      emit(after, 2);
      expect(action).toHaveBeenCalledOnce();
    } finally { view.unmount(); seat.remove(); vi.stubGlobal("ResizeObserver", originalObserver); }
  });
  it("keeps workspace values out of executable/public fields and requires exact completed geometry", () => {
    const state: NativeWorkspaceProjection = { documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1, workspace: "referrals",
      appearance: "light", accentHex: "#007aff", foregroundHex: "#111111", updateSequence: 1, privacyGeneration: 0, isolationGeneration: 0,
      frame: { x: 0, y: 100, width: 390, height: 500, viewportWidth: 390, viewportHeight: 844, layoutRevision: 1 },
      page: "circle-create", title: "Create a Circle", enabled: true, backEnabled: true, sections: [],
      circleEditor: { destinationId: "public-circle-visit", draft: { name: "Synthetic Circle", kind: "friends" }, draftRevision: 0, acknowledgedEditRevision: 0, canSave: true, busy: false, error: null } };
    expect(validNativeWorkspace(state)).toBe(true);
    expect(validNativeWorkspace({ ...state, vaultOwnerToken: "forbidden" } as never)).toBe(false);
    expect(validNativeWorkspace({ ...state, circleEditor: { ...state.circleEditor!, draft: { ...state.circleEditor!.draft, credential: "forbidden" } } } as never)).toBe(false);
    expect(validNativeWorkspace({ ...state, frame: { ...state.frame, height: 900 } })).toBe(false);
    expect(validNativeWorkspace({ ...state, frame: { ...state.frame, contentInset: 24 } })).toBe(true);
    expect(validNativeWorkspace({ ...state, frame: { ...state.frame, contentInset: -1 } })).toBe(false);
    expect(validNativeWorkspace({ ...state, frame: { ...state.frame, contentInset: 200 } })).toBe(false);
    expect(validNativeWorkspace({ ...state, sections: [{ id: "choices", rows: [{ id: "choice", label: "Unsafe", enabled: true, href: "https://example.com" }] }] } as never)).toBe(false);
    const receipt = { ...state, layoutRevision: 1, phase: "active" as const, settled: true };
    expect(workspaceAcknowledged(receipt, state, "active")).toBe(true);
    expect(workspaceAcknowledged({ ...receipt, settled: false }, state, "active")).toBe(false);
    expect(workspaceAcknowledged({ ...receipt, revision: 2 }, state, "active")).toBe(false);
    expect(workspaceAcknowledged({ ...receipt, layoutRevision: 2 }, state, "active")).toBe(false);
  });
});

function publicNameScene(): NativeProfileNameProjection {
  return { documentId: "public-form-document", ownerEpoch: "public-form-owner", ownerGeneration: 1,
    revision: 1, family: "profile", scene: "account-name", appearance: "light", accentHex: "#007aff",
    foregroundHex: "#808080", updateSequence: 1, privacyGeneration: 0, draftRevision: 0,
    acknowledgedEditRevision: 0, draft: "Public Example", canSave: true, busy: false, error: null };
}

describe("ordinary private Profile form contract", () => {
  it("keeps custom-server credentials in their closed scene and rejects stale final input or repeated saves", async () => {
    const state: NativeConnectorProjection = { ...publicNameScene(), scene: "connector-custom-server", destinationId: "custom-server-visit",
      draft: { name: "Synthetic server", endpoint: "https://example.com/mcp", credential: "synthetic-private-input", oauthIssuer: "", oauthClientId: "", oauthClientSecret: "", oauthAuthMethod: "none" } };
    expect(validNativeConnectorProjection(state)).toBe(true);
    expect(validNativeConnectorProjection({ ...state, draft: { ...state.draft, vaultKey: "forbidden" } } as never)).toBe(false);
    expect(validNativeConnectorProjection({ ...state, draft: { ...state.draft, oauthClientSecret: "hidden-secret" } })).toBe(false);
    expect(validNativeConnectorProjection({ ...state, scene: "runtime-provider" } as never)).toBe(false);
    const link: NativeConnectorProjection = { ...state, scene: "connector-profile-link", draft: { network: "instagram", link: "https://www.instagram.com/example/" } };
    const price: NativeConnectorProjection = { ...state, scene: "connector-packet-price", draft: { price: "12.34" } };
    expect(validNativeConnectorProjection(link)).toBe(true);
    expect(validNativeConnectorProjection(price)).toBe(true);
    expect(validNativeConnectorProjection({ ...link, draft: state.draft })).toBe(false);
    expect(validNativeConnectorProjection({ ...price, draft: { ...price.draft, credential: "forbidden" } } as never)).toBe(false);
    const pages = (ids: readonly string[]) => ids.map(id => ({ id, title: "Public page", sections: [] })) as never;
    expect(validNativeConnectorPath(pages(["connectors", "connector-custom"]))).toBe(true);
    expect(validNativeConnectorPath(pages(["connectors", "connector-detail", "connector-confirm"]))).toBe(true);
    expect(validNativeConnectorPath(pages(["connectors", "account-delete"]))).toBe(false);
    expect(validNativeConnectorPath(pages(["connectors", "connector-custom", "connector-confirm"]))).toBe(false);
    expect(validNativeConnectorPath(pages(["connectors", "connector-detail", "connector-trust", "connector-trust-rule", "connector-trust-confirm"]))).toBe(true);
    expect(validNativeConnectorPath(pages(["connectors", "connector-detail", "connector-packets", "connector-trust-confirm"]))).toBe(false);
    const { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId } = state;
    const edit = { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId, draft: state.draft,
      updateSequence: 1, privacyGeneration: 0, editRevision: 1, composing: false };
    const final = { ...edit, baseDraftRevision: 0, acknowledgedEditRevision: 0 };
    expect(validNativeConnectorFinalEdit(final, state)).toBe(true);
    expect(validNativeConnectorFinalEdit({ ...final, destinationId: "retired-visit" }, state)).toBe(false);
    expect(validNativeConnectorFinalEdit({ ...final, composing: true }, state)).toBe(false);
    expect(validNativeConnectorFinalEdit({ ...final, scene: "connector-packet-price", draft: price.draft }, state)).toBe(false);
    const fence = new NativeConnectorFence(state);
    expect(fence.update(state)).toBe(true);
    expect(fence.consumeEdit(edit)).toBe(true);
    const action = { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId, updateSequence: 1,
      privacyGeneration: 0, editRevision: 1, sequence: 1, action: "save" as const };
    expect(fence.allows(action)).toBe(false);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(true);
    expect(await fence.consumeAction({ ...action, updateSequence: 2 }, async () => ({ valid: true }), () => true)).toBe(true);
    expect(await fence.consumeAction({ ...action, updateSequence: 2 }, async () => ({ valid: true }), () => true)).toBe(false);
    fence.retire();
    expect(fence.consumeEdit({ ...edit, editRevision: 2 })).toBe(false);
  });
  it("fences private Memory text by its destination, committed edit and single save", async () => {
    const state: NativeMemoryProjection = { documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1,
      family: "profile", scene: "memory-financial-context", destinationId: "public-memory-visit", updateSequence: 1, privacyGeneration: 0,
      acknowledgedEditRevision: 0, draftRevision: 0, appearance: "light", accentHex: "#007aff", foregroundHex: "#111111", error: null,
      draft: { category: "risk", text: "Synthetic multiline\n漢字 😀" }, canSave: true, busy: false };
    expect(validNativeMemoryProjection(state)).toBe(true);
    expect(validNativeMemoryProjection({ ...state, draft: { ...state.draft, recordId: "forbidden-authority" } } as never)).toBe(false);
    expect(validNativeMemoryProjection({ ...state, draft: { ...state.draft, category: "unknown" } } as never)).toBe(false);
    const { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId } = state;
    const identity = { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId };
    const edit = { ...identity, draft: state.draft, updateSequence: 1, privacyGeneration: 0, editRevision: 1, composing: false };
    const final = { ...edit, baseDraftRevision: 0, acknowledgedEditRevision: 0 };
    expect(validNativeMemoryFinalEdit(final, state)).toBe(true);
    expect(validNativeMemoryFinalEdit({ ...final, destinationId: "reopened-visit" }, state)).toBe(false);
    expect(validNativeMemoryFinalEdit({ ...final, composing: true }, state)).toBe(false);
    const fence = new NativeMemoryFence(state);
    expect(fence.update(state)).toBe(true);
    expect(fence.consumeEdit({ ...edit, ownerEpoch: "retired-owner" })).toBe(false);
    expect(fence.consumeEdit(edit)).toBe(true);
    const action = { ...identity, updateSequence: 1, privacyGeneration: 0, editRevision: 1, sequence: 1, action: "save" as const };
    expect(fence.allows(action)).toBe(false);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(true);
    expect(await fence.consumeAction({ ...action, updateSequence: 2 }, async () => ({ valid: true }), () => true)).toBe(true);
    expect(await fence.consumeAction({ ...action, updateSequence: 2 }, async () => ({ valid: true }), () => true)).toBe(false);
    fence.retire();
    expect(fence.consumeEdit({ ...edit, editRevision: 2 })).toBe(false);
  });
  it("fences the private provider form by destination, final edit and one-shot confirmation", async () => {
    const state: NativeRuntimeProjection = { documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1,
      family: "profile", scene: "runtime-provider", destinationId: "public-runtime-visit", updateSequence: 1, privacyGeneration: 0,
      acknowledgedEditRevision: 0, draftRevision: 0, appearance: "light", accentHex: "#007aff", foregroundHex: "#111111", primary: "validate", error: null,
      draft: { credential: "synthetic-provider-key", transport: "developer_api", project: "", location: "global" }, canSave: true, busy: false, checking: false };
    expect(validNativeRuntimeProjection(state)).toBe(true);
    expect(validNativeRuntimeProjection({ ...state, draft: { ...state.draft, vaultKey: "forbidden" } } as never)).toBe(false);
    const fence = new NativeRuntimeFence(state);
    expect(fence.update(state)).toBe(true);
    const { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId } = state;
    const identity = { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId };
    const edit = { ...identity, draft: state.draft, updateSequence: 1, privacyGeneration: 0, editRevision: 1, composing: false };
    const finalEdit = { ...edit, baseDraftRevision: 0, acknowledgedEditRevision: 0 };
    expect(validNativeRuntimeFinalEdit(finalEdit, state)).toBe(true);
    expect(validNativeRuntimeFinalEdit({ ...finalEdit, destinationId: "retired-visit" }, state)).toBe(false);
    expect(validNativeRuntimeFinalEdit({ ...finalEdit, composing: true }, state)).toBe(false);
    expect(fence.consumeEdit({ ...edit, destinationId: "retired-runtime-visit" })).toBe(false);
    expect(fence.consumeEdit(edit)).toBe(true);
    const action = { ...identity, updateSequence: 1, privacyGeneration: 0, editRevision: 1, sequence: 1, action: "save" as const };
    expect(fence.allows(action)).toBe(false);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(true);
    const final = { ...action, updateSequence: 2 };
    expect(await fence.consumeAction(final, async () => ({ valid: true }), () => true)).toBe(true);
    expect(await fence.consumeAction(final, async () => ({ valid: true }), () => true)).toBe(false);
    fence.retire();
    expect(fence.consumeEdit({ ...edit, editRevision: 2 })).toBe(false);
  });
  it.each<WorldModelForm>([
    { scene: "world-model-fact-edit", draft: { text: "Public corrected statement" } },
    { scene: "world-model-sources", draft: { urls: "https://public.example/profile", permitted: true } },
    { scene: "world-model-public-profiles", draft: { urls: "https://public.example/profile", permitted: true } },
    { scene: "world-model-invitation", draft: { name: "Public Example", email: "public@example.com", phone: "" } },
  ])("fences the private $scene form by visit and consumes only its final acknowledged edit", async form => {
    const state: NativeWorldModelProjection = { ...publicNameScene(), ...form, destinationId: "world-model-first-visit" };
    expect(validNativeWorldModelProjection(state)).toBe(true);
    expect(validNativeWorldModelProjection({ ...state, draft: { ...state.draft, vaultKey: "forbidden" } } as never)).toBe(false);
    const fence = new NativeWorldModelFence(state);
    expect(fence.update(state)).toBe(true);
    const { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId } = state;
    const identity = { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId };
    const edit = { ...identity, ...form, updateSequence: 1, privacyGeneration: 0, editRevision: 1, composing: false };
    expect(fence.consumeEdit({ ...edit, destinationId: "retired-visit" })).toBe(false);
    expect(fence.consumeEdit(edit)).toBe(true);
    const action = { ...identity, updateSequence: 1, privacyGeneration: 0, editRevision: 1, sequence: 1, action: "save" as const };
    expect(fence.allows(action)).toBe(false);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(true);
    const final = { ...action, updateSequence: 2 };
    expect(await fence.consumeAction(final, async () => ({ valid: true }), () => true)).toBe(true);
    expect(await fence.consumeAction(final, async () => ({ valid: true }), () => true)).toBe(false);
    fence.retire();
    expect(fence.consumeEdit({ ...edit, editRevision: 2 })).toBe(false);
  });
  it.each(["pricing", "password"])("keeps Profile-scoped Back in its mounted %s editor while admission is unavailable", kind => {
    const previous = privacy.state;
    privacy.state = { ...previous, shielded: true, appIsActive: false };
    const parent = vi.fn(() => true);
    const remove = registerBackLayer({ pathname: profile.pathname, depth: 1, query: { profile_pane: "1" }, back: parent });
    const props = { userId: "synthetic-owner", destinationId: "synthetic-visit", onFallback: vi.fn() };
    const view = kind === "pricing" ? render(<NativeRequestPricingEditor {...props} model={{ saving: true } as never} onClose={vi.fn()} />) :
      render(<NativeVaultPasswordEditor {...props} model={{ busy: true } as never} />);
    try {
      act(() => backProfilePane(profile.pathname, new URLSearchParams("profile_pane=1")));
      expect(parent).not.toHaveBeenCalled();
      view.unmount();
      act(() => backProfilePane(profile.pathname, new URLSearchParams("profile_pane=1")));
      expect(parent).toHaveBeenCalledOnce();
    } finally { view.unmount(); remove(); privacy.state = previous; }
  });

  it("preserves unfinished Phone text through confirmed fallback without sending older digits", async () => {
    bridge.platform = "ios"; publishValidatedAuthSessionOwner("phone-fallback-owner");
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    privacy.state = { generation: 0, shielded: false, appIsActive: true, cause: "inactive" };
    drawerBridge.getCapabilities.mockResolvedValue({ generation: 0, isolated: false });
    drawerBridge.applyProfilePhoneScene.mockImplementation(async state => {
      if (state.acknowledgedEditRevision === 1) throw new Error("synthetic-native-failure");
      return { ...state, phase: "active" };
    });
    drawerBridge.retireProfilePhoneScene.mockImplementation(async identity => ({ ...identity, phase: "retired",
      updateSequence: drawerBridge.applyProfilePhoneScene.mock.calls.at(-1)![0].updateSequence, privacyGeneration: 0 }));
    const start = vi.fn().mockResolvedValue({ autoVerified: false }), confirm = vi.fn();
    function Phone() {
      const [host, setHost] = useState<HTMLDivElement | null>(null), [native, setNative] = useState(true);
      return <><div ref={setHost} /><NativePhoneVerificationFlow native={native} destinationId="phone-fallback-first" webHost={host}
        ownerKey="phone-fallback-visit" isCurrent={() => true} mode="replace" currentPhoneNumber="+16505550101"
        startVerification={start} confirmVerification={confirm} onCompleted={vi.fn()} onFallback={() => setNative(false)} /></>;
    }
    const view = render(<Phone />);
    await waitFor(() => expect(drawerBridge.applyProfilePhoneScene.mock.calls.at(-1)?.[0].draft.number).toBe("6505550101"));
    const state = drawerBridge.applyProfilePhoneScene.mock.calls.at(-1)![0];
    const edit = { ...fenceIdentity(state), scene: "phone", destinationId: state.destinationId, updateSequence: state.updateSequence,
      privacyGeneration: 0, editRevision: 1, composing: true, step: "phone", draft: { ...state.draft, number: "6505550101あ" } };
    act(() => drawerBridge.listeners.get("profilePhoneEdit")?.forEach(listener => listener(edit)));
    const input = await screen.findByRole("textbox", { name: "Phone number" });
    expect(input).toHaveValue("6505550101あ");
    expect(drawerBridge.retireProfilePhoneScene).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Send verification code" })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(start).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "650555010199" } });
    expect(input).toHaveValue("650555010199");
    expect(screen.getByRole("button", { name: "Send verification code" })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(start).not.toHaveBeenCalled();
    (input as HTMLInputElement).setSelectionRange(0, 12);
    fireEvent.paste(input, { clipboardData: { getData: () => "+916505550102" } });
    expect(input).toHaveValue("6505550102");
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(start).toHaveBeenCalledWith("+916505550102", { resendCode: false }));
    view.unmount();
  });
  it("keeps Phone edits on their current stage and acknowledges a one-shot verification before dispatch", async () => {
    const state: NativePhoneProjection = { ...publicNameScene(), destinationId: "phone-first", scene: "phone", mode: "replace", step: "phone",
      draft: { country: "US", number: "6505550101", code: "" }, countries: [{ value: "US", label: "United States", dialCode: "+1" }], maskedDestination: "••••••0101" };
    expect(validNativePhoneProjection(state)).toBe(true);
    expect(validNativePhoneProjection({ ...state, draft: { ...state.draft, verificationId: "not-a-challenge" } } as never)).toBe(false);
    expect(validNativePhoneProjection({ ...state, ownerToken: "not-a-token" } as never)).toBe(false);
    const fence = new NativePhoneFence(state);
    expect(fence.update(state)).toBe(true);
    const identity = { ...fenceIdentity(state), scene: "phone" as const, destinationId: state.destinationId };
    const edit = { ...identity, updateSequence: 1, privacyGeneration: 0, editRevision: 1, step: "phone" as const, composing: false, draft: state.draft };
    expect(fence.consumeEdit({ ...edit, step: "code" })).toBe(false);
    expect(fence.consumeEdit(edit)).toBe(true);
    const send = { ...identity, updateSequence: 2, privacyGeneration: 0, editRevision: 1, sequence: 1, action: "change" as const, intent: "send" as const };
    expect(fence.allows(send)).toBe(false);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(true);
    expect(fence.allows({ ...send, destinationId: "phone-reopened" })).toBe(false);
    const confirm = vi.fn(async () => ({ valid: true }));
    expect(await fence.consumeAction(send, confirm, () => true)).toBe(true);
    expect(await fence.consumeAction(send, confirm, () => true)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(fence.update({ ...state, updateSequence: 3, acknowledgedEditRevision: 1, step: "code" })).toBe(true);
    expect(fence.consumeEdit({ ...edit, updateSequence: 2, editRevision: 2 })).toBe(false);
    expect(fence.allows({ ...send, updateSequence: 3, sequence: 2 })).toBe(false);
    expect(fence.allows({ ...send, intent: "resend", updateSequence: 3, sequence: 2 })).toBe(true);
    fence.retire();
    expect(fence.allows({ ...send, intent: "verify", updateSequence: 3, sequence: 3 })).toBe(false);
  });

  it("admits only closed Writing Style values and consumes a current acknowledged Save once", async () => {
    const state: NativeProfileStyleProjection = { ...publicNameScene(), destinationId: "preferences-first", scene: "writing-style", draft: { tone: "warm" },
      choices: STYLE_CHOICE_OPTIONS, unavailable: false, suggested: false };
    expect(validNativeProfileStyleProjection(state)).toBe(true);
    expect(validNativeProfileStyleProjection({ ...state, vaultKey: "synthetic-not-a-key" } as never)).toBe(false);
    expect(validNativeProfileStyleProjection({ ...state, draft: { tone: "invented" } } as never)).toBe(false);
    expect(validNativeProfileStyleProjection({ ...state, draft: { credentials: "synthetic" } } as never)).toBe(false);
    const fence = new NativeProfileStyleFence(state);
    expect(fence.update(state)).toBe(true);
    const event = { ...fenceIdentity(state), destinationId: state.destinationId, scene: "writing-style" as const, updateSequence: 1, privacyGeneration: 0, editRevision: 1,
      field: "tone" as const, value: "direct" as const, composing: false };
    expect(fence.consumeEdit({ ...event, value: "invented" } as never)).toBe(false);
    expect(fence.consumeEdit({ ...event, ownerEpoch: "old-owner" })).toBe(false);
    expect(fence.consumeEdit({ ...event, destinationId: "preferences-reopened" })).toBe(false);
    expect(fence.consumeEdit(event)).toBe(true);
    const action = { ...fenceIdentity(state), destinationId: state.destinationId, scene: "writing-style" as const, updateSequence: 2, privacyGeneration: 0, editRevision: 1, sequence: 1, action: "save" as const };
    expect(fence.allows(action)).toBe(false);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1, draft: { tone: "direct" } })).toBe(true);
    expect(fence.allows({ ...action, destinationId: "preferences-reopened" })).toBe(false);
    const confirm = vi.fn(async () => ({ valid: true }));
    expect(await fence.consumeAction(action, confirm, () => true)).toBe(true);
    expect(await fence.consumeAction(action, confirm, () => true)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    fence.retire();
    expect(fence.consumeEdit({ ...event, editRevision: 2 })).toBe(false);
  });

  it("keeps a Writing Style sheet after confirmed Save and never repeats its operation", async () => {
    const state: NativeProfileStyleProjection = { ...publicNameScene(), scene: "writing-style", draft: { tone: "warm" },
      choices: STYLE_CHOICE_OPTIONS, unavailable: false, suggested: false };
    const listeners = new Map<string, (event: never) => void>();
    const settle = vi.fn(async () => ({ valid: true }));
    const retire = vi.fn(async () => ({ ...fenceIdentity(state), scene: "writing-style" as const, updateSequence: 1, privacyGeneration: 0, phase: "retired" as const }));
    const source = { getCapabilities: async () => ({ generation: nativeDrawerIsolation().generation, isolated: nativeDrawerIsolation().isolated }),
      addListener: async (key: string, listener: (event: never) => void) => { listeners.set(key, listener); return { remove: async () => { listeners.delete(key); } }; } };
    const phases: string[] = [];
    const presentation = new NativeProfileScenePresentation(state, { source: source as never,
      apply: async next => ({ ...fenceIdentity(next), scene: "writing-style", updateSequence: next.updateSequence, privacyGeneration: next.privacyGeneration, phase: "active" }),
      confirm: async () => ({ valid: true }), settle, retire,
      edits: callback => source.addListener("edit", callback), choices: callback => source.addListener("action", callback),
    }, new NativeProfileStyleFence(state), validNativeProfileStyleProjection, () => true, phase => phases.push(phase), false);
    const commit = vi.fn(async () => ({ kind: "saved" as const, value: undefined }));
    const actions = { edit: vi.fn(), commit, saved: vi.fn(), cancel: vi.fn() };
    expect(await presentation.listen()).toBe(true);
    expect(presentation.publish(state, actions)).toBe(true);
    await waitFor(() => expect(phases).toEqual(["active"]));
    const event = { ...fenceIdentity(state), scene: "writing-style", updateSequence: 1, privacyGeneration: 0, editRevision: 0, sequence: 1, action: "save" };
    listeners.get("action")?.(event as never);
    await waitFor(() => expect(settle).toHaveBeenCalledWith(event, true));
    listeners.get("action")?.(event as never);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(retire).not.toHaveBeenCalled();
    await presentation.retire();
    expect(retire).toHaveBeenCalledTimes(1);
  });
  it("skips an intermediate React edit echo without retiring the retained native editor", async () => {
    const state = publicNameScene();
    const listeners = new Map<string, (value: unknown) => void>();
    const phases: string[] = [];
    const retire = vi.fn(async () => formRetirement(state));
    const apply = vi.fn(async (next: NativeProfileNameProjection) => ({ ...fenceIdentity(next),
      phase: "active" as const, updateSequence: next.updateSequence, privacyGeneration: next.privacyGeneration }));
    const plugin = { applyProfileNameScene: apply, retireProfileNameScene: retire,
      getCapabilities: async () => ({ contractVersion: 1, supported: true,
        generation: nativeDrawerIsolation().generation, isolated: nativeDrawerIsolation().isolated }),
      addListener: async (name: string, listener: (value: unknown) => void) => {
        listeners.set(name, listener); return { remove: async () => { listeners.delete(name); } };
      } };
    const presentation = new NativeProfileNamePresentation(state, plugin as never, () => true, phase => phases.push(phase));
    const actions = { edit: vi.fn(), save: vi.fn(), saved: vi.fn(), cancel: vi.fn() };
    expect(await presentation.listen()).toBe(true);
    expect(presentation.publish(state, actions)).toBe(true);
    await waitFor(() => expect(phases).toEqual(["active"]));
    const event = { ...fenceIdentity(state), updateSequence: 1, privacyGeneration: 0, composing: false };
    listeners.get("profileNameEdit")?.({ ...event, editRevision: 1, text: "Public A" });
    listeners.get("profileNameEdit")?.({ ...event, editRevision: 2, text: "Public AB" });
    expect(presentation.publish({ ...state, updateSequence: 2, acknowledgedEditRevision: 1, draft: "Public A" }, actions)).toBe(false);
    expect(presentation.publish({ ...state, updateSequence: 3, acknowledgedEditRevision: 2, draft: "Public AB" }, actions)).toBe(true);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(phases).not.toContain("blocked");
    expect(retire).not.toHaveBeenCalled();
    expect(actions.save).not.toHaveBeenCalled();
    await presentation.retire();
  });

  it("bounds stalled listener admission and removes its late handle without presenting a form", async () => {
    vi.useFakeTimers();
    try {
      const state = publicNameScene();
      const late = deferred<{ remove: () => Promise<void> }>();
      const remove = vi.fn(async () => undefined);
      const phases: string[] = [];
      const apply = vi.fn();
      const plugin = { addListener: () => late.promise, applyProfileNameScene: apply,
        retireProfileNameScene: async () => formRetirement({ ...state, updateSequence: 0 }),
        getCapabilities: async () => ({ contractVersion: 1, supported: true,
          generation: nativeDrawerIsolation().generation, isolated: nativeDrawerIsolation().isolated }),
      };
      const presentation = new NativeProfileNamePresentation(state, plugin as never, () => true, phase => phases.push(phase));
      const pending = presentation.listen();
      expect(presentation.publish(state, { edit: vi.fn(), save: vi.fn(), saved: vi.fn(), cancel: vi.fn() })).toBe(false);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(phases).toEqual(["blocked", "fallback"]);
      expect(await pending).toBe(false);
      expect(apply).not.toHaveBeenCalled();
      late.resolve({ remove });
      await Promise.resolve();
      expect(remove).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("keeps password editing private and requires the latest committed pair before a one-shot change", async () => {
    const state: NativePasswordProjection = { ...fenceIdentity(publicNameScene()), family: "profile", scene: "vault-passphrase", destinationId: "vault-visit",
      appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111", updateSequence: 1, privacyGeneration: 0,
      acknowledgedEditRevision: 0, password: "", confirmation: "", busy: false, canSave: false };
    expect(validNativePasswordProjection(state)).toBe(true);
    expect(validNativePasswordProjection({ ...state, vaultKey: "forbidden" } as NativePasswordProjection)).toBe(false);
    const fence = new NativePasswordFence(state);
    expect(fence.update(state)).toBe(true);
    const { appearance: _appearance, accentHex: _accent, foregroundHex: _foreground, password: _password, confirmation: _confirmation,
      acknowledgedEditRevision: _ack, busy: _busy, canSave: _canSave, ...metadata } = state;
    const edit = { ...metadata, editRevision: 1, password: "Synthetic new password", confirmation: "Synthetic new password", composing: true };
    expect(fence.consumeEdit({ ...edit, destinationId: "retired-visit" })).toBe(false);
    expect(fence.consumeEdit(edit)).toBe(true);
    const action = { ...metadata, action: "save" as const, sequence: 1, editRevision: 1 };
    expect(fence.allows(action)).toBe(false);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1, password: edit.password, confirmation: edit.confirmation, canSave: true })).toBe(true);
    expect(fence.allows({ ...action, updateSequence: 2 })).toBe(false);
    expect(fence.consumeEdit({ ...edit, updateSequence: 2, editRevision: 2, composing: false })).toBe(true);
    expect(fence.update({ ...state, updateSequence: 3, acknowledgedEditRevision: 2, password: edit.password, confirmation: edit.confirmation, canSave: true })).toBe(true);
    const committed = { ...action, updateSequence: 3, editRevision: 2 };
    expect(await fence.consumeAction(committed, async () => ({ valid: true }), () => true)).toBe(true);
    expect(await fence.consumeAction(committed, async () => ({ valid: true }), () => true)).toBe(false);
    fence.retire();
    expect(fence.consumeEdit({ ...edit, editRevision: 2 })).toBe(false);
  });

  it("admits only a bounded name scene, never credentials or another owner's edit", () => {
    const state = publicNameScene();
    expect(validNativeProfileNameProjection(state)).toBe(true);
    expect(validNativeProfileNameProjection({ ...state, vaultKey: "synthetic-forbidden" } as NativeProfileNameProjection)).toBe(false);
    const handle: NativeProfileNameProjection = { ...state, scene: "referral-handle", draft: "public-handle", destinationId: "referral-visit" };
    expect(validNativeProfileNameProjection(handle)).toBe(true);
    expect(validNativeProfileNameProjection({ ...handle, draft: "x".repeat(33) })).toBe(false);
    const handleFence = new NativeProfileNameFence(handle);
    expect(handleFence.update(handle)).toBe(true);
    expect(handleFence.update({ ...handle, scene: "account-name", updateSequence: 2 })).toBe(false);
    expect(handleFence.consumeEdit({ ...handle, updateSequence: 1, editRevision: 1, text: "other-handle", composing: false,
      destinationId: "old-referral-visit" })).toBe(false);
    const fence = new NativeProfileNameFence(state);
    expect(fence.update(state)).toBe(true);
    const event = { ...fenceIdentity(state), updateSequence: 1, privacyGeneration: 0,
      editRevision: 1, text: "Public New Name", composing: true };
    expect(fence.consumeEdit({ ...event, ownerEpoch: "another-owner" })).toBe(false);
    expect(fence.consumeEdit(event)).toBe(true);
    expect(fence.consumeEdit({ ...event, text: "Reordered old edit" })).toBe(false);
    expect(fence.allows({ ...fenceIdentity(state), updateSequence: 1, privacyGeneration: 0,
      sequence: 1, editRevision: 1, action: "save" })).toBe(false);
  });

  it("consumes an acknowledged Save once and refuses a changed owner after confirmation", async () => {
    const state = publicNameScene();
    const fence = new NativeProfileNameFence(state);
    fence.update(state);
    const action = { ...fenceIdentity(state), updateSequence: 1, privacyGeneration: 0,
      sequence: 1, editRevision: 0, action: "save" as const };
    const reply = deferred<{ valid: boolean }>();
    let current = true;
    const pending = fence.consumeAction(action, () => reply.promise, () => current);
    expect(await fence.consumeAction(action, async () => ({ valid: true }), () => true)).toBe(false);
    current = false;
    reply.resolve({ valid: true });
    expect(await pending).toBe(false);
    const positive = new NativeProfileNameFence(state);
    positive.update(state);
    expect(await positive.consumeAction(action, async () => ({ valid: true }), () => true)).toBe(true);
    positive.retire();
    expect(positive.allows({ ...action, sequence: 2 })).toBe(false);
  });

  it("keeps a terminal Cancel through an appearance update but rejects an old Save", async () => {
    const state = publicNameScene();
    const fence = new NativeProfileNameFence(state);
    fence.update(state);
    const action = { ...fenceIdentity(state), updateSequence: 1, privacyGeneration: 0,
      sequence: 1, editRevision: 0, action: "cancel" as const };
    const reply = deferred<{ valid: boolean }>();
    const pending = fence.consumeAction(action, () => reply.promise, () => true);
    expect(fence.update({ ...state, updateSequence: 2, appearance: "dark" })).toBe(true);
    reply.resolve({ valid: true });
    expect(await pending).toBe(true);
    expect(fence.allows({ ...action, sequence: 2, action: "save" })).toBe(false);
    expect(fence.allows({ ...action, sequence: 2, privacyGeneration: 1 })).toBe(false);
  });

  it("never reveals fallback until the owned native form finishes retirement", async () => {
    const state = publicNameScene();
    const retired = deferred<ReturnType<typeof formRetirement>>();
    const phases: string[] = [];
    const handles = new Map<string, (value: unknown) => void>();
    const plugin = {
      getCapabilities: async () => ({ contractVersion: 1, supported: true, wholePresentation: true, generation: nativeDrawerIsolation().generation, isolated: nativeDrawerIsolation().isolated }),
      addListener: vi.fn(async (name: string, listener: (value: unknown) => void) => {
        handles.set(name, listener); return { remove: async () => { handles.delete(name); } };
      }),
      applyProfileNameScene: vi.fn(async () => { throw new Error("synthetic uncertain apply"); }),
      confirmProfileNameAction: vi.fn(async () => ({ valid: true })),
      settleProfileNameAction: vi.fn(async () => ({ valid: true })),
      retireProfileNameScene: vi.fn(() => retired.promise),
      apply: vi.fn(), retire: vi.fn(), confirmChoice: vi.fn(),
    };
    const presentation = new NativeProfileNamePresentation(state, plugin, () => true, phase => phases.push(phase));
    expect(await presentation.listen()).toBe(true);
    const save = vi.fn(async () => ({ kind: "retained" as const }));
    presentation.publish(state, { edit: vi.fn(), save, saved: vi.fn(), cancel: vi.fn() });
    await waitFor(() => expect(phases).toEqual(["blocked"]));
    expect(save).not.toHaveBeenCalled();
    retired.resolve(formRetirement(state));
    await waitFor(() => expect(phases).toEqual(["blocked", "fallback"]));
    expect(handles.size).toBe(0);
  });
});

function fenceIdentity(state: Pick<NativeProfileNameProjection, "documentId" | "ownerEpoch" | "ownerGeneration" | "revision">) {
  return { documentId: state.documentId, ownerEpoch: state.ownerEpoch, ownerGeneration: state.ownerGeneration,
    revision: state.revision, family: "profile" as const, scene: "account-name" as const };
}
function formRetirement(state: NativeProfileNameProjection) {
  return { ...fenceIdentity(state), updateSequence: state.updateSequence, privacyGeneration: state.privacyGeneration, phase: "retired" as const };
}

// Keep qualification-only lifecycle coverage without enabling it in the app.
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({
  customNativePresentationEnabled: vi.fn(() => true),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "dock-reviewer" } }) }));

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
const profile = vi.hoisted(() => ({ query: "profile_pane=1", unlocked: true, pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => profile.pathname, useSearchParams: () => new URLSearchParams(profile.query) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: profile.unlocked }) }));
vi.mock("@/components/profile/profile-workspace-page", () => ({ ProfilePage: () => null }));

const bridge = vi.hoisted(() => ({ platform: "ios", documentId: "document-a", callbacks: new Map<string, (event: unknown) => void>(),
  listeners: new Map<string, Set<(event: unknown) => void>>(), setPresentationRegions: vi.fn(), applyPanelPose: vi.fn(), retirePanel: vi.fn(),
  acquireContentPane: vi.fn(), releaseContentPane: vi.fn(),
  subscribe: vi.fn(), prepare: vi.fn(), prepareBackReplacement: vi.fn(), prepareHistoryReplacement: vi.fn(), activate: vi.fn(), update: vi.fn(), suspend: vi.fn(), retire: vi.fn(), restoreFocus: vi.fn(), confirmChoice: vi.fn(), getCapabilities: vi.fn(), setCanvasAppearance: vi.fn() }));
const dockBridge = vi.hoisted(() => ({ callbacks: new Map<string, (event: unknown) => void>(),
  subscribe: vi.fn(), getCapabilities: vi.fn(), apply: vi.fn(), retire: vi.fn(), suspend: vi.fn(), consumeDraft: vi.fn(), beginEditingTransition: vi.fn(), confirmEvent: vi.fn(), snapshotDraft: vi.fn() }));
const drawerBridge = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: unknown) => void>>(),
  copyProfileReferralLink: vi.fn().mockResolvedValue({ copied: true }),
  applyWorkspace: vi.fn(), retireWorkspace: vi.fn(), confirmWorkspaceChoice: vi.fn(), settleWorkspaceChoice: vi.fn(), getWorkspaceState: vi.fn(),
  getCapabilities: vi.fn(), getPresentationState: vi.fn(), apply: vi.fn(), retire: vi.fn(), confirmChoice: vi.fn(),
  applyProfileNameScene: vi.fn(), confirmProfileNameAction: vi.fn(), settleProfileNameAction: vi.fn(), retireProfileNameScene: vi.fn(),
  applyProfileStyleScene: vi.fn(), confirmProfileStyleAction: vi.fn(), settleProfileStyleAction: vi.fn(), retireProfileStyleScene: vi.fn(),
  applyProfileSupportScene: vi.fn(), confirmProfileSupportAction: vi.fn(), settleProfileSupportAction: vi.fn(), retireProfileSupportScene: vi.fn(),
  applyProfilePhoneScene: vi.fn(), confirmProfilePhoneAction: vi.fn(), settleProfilePhoneAction: vi.fn(), retireProfilePhoneScene: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => bridge.platform !== "web", getPlatform: () => bridge.platform },
  registerPlugin: (plugin: string) => plugin === "HushhNativeDrawers" ? { ...drawerBridge,
    addListener: async (name: string, callback: (event: unknown) => void) => {
      const listeners = drawerBridge.listeners.get(name) ?? new Set<(event: unknown) => void>();
      listeners.add(callback); drawerBridge.listeners.set(name, listeners);
      return { remove: async () => { listeners.delete(callback); } };
    },
  } : plugin === "HushhNativeDock" ? { ...dockBridge,
    addListener: async (name: string, callback: (event: unknown) => void) => {
      await dockBridge.subscribe(name);
      dockBridge.callbacks.set(name, callback);
      return { remove: async () => { if (dockBridge.callbacks.get(name) === callback) dockBridge.callbacks.delete(name); } };
    },
  } : ({ ...bridge, addListener: async (name: string, callback: (event: unknown) => void) => {
    await bridge.subscribe(name);
    const listeners = bridge.listeners.get(name) ?? new Set<(event: unknown) => void>();
    listeners.add(callback);
    bridge.listeners.set(name, listeners);
    bridge.callbacks.set(name, (event) => listeners.forEach((listener) => listener(event)));
    return { remove: async () => { listeners.delete(callback); if (!listeners.size) bridge.callbacks.delete(name); } };
  } }),
}));
const privacy = vi.hoisted(() => ({ callbacks: new Set<(event: { generation: number; shielded: boolean; appIsActive: boolean }) => void>(),
  observations: new Set<() => void>(), epoch: 0,
  state: { generation: 0, shielded: false, appIsActive: true, cause: "inactive" as const } }));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativeDocumentId: () => bridge.documentId,
  expectNativeProfilePreparation: () => () => undefined,
  nativePrivacyCanInteract: (state = privacy.state) => !!state?.appIsActive && !state.shielded,
  nativePrivacyCanPrepareProfile: (state = privacy.state) => !!state?.appIsActive && !state.shielded,
  subscribeNativePrivacyObservation: (callback: () => void) => {
    privacy.observations.add(callback); return () => { privacy.observations.delete(callback); };
  },
  nativePrivacyObservation: () => ({ state: privacy.state, epoch: privacy.epoch }),
  getNativeSessionPrivacyState: async () => privacy.state,
  subscribeNativeSessionPrivacy: async (callback: (event: { generation: number; shielded: boolean; appIsActive: boolean }) => void) => {
    privacy.callbacks.add(callback);
    return { remove: async () => { privacy.callbacks.delete(callback); } };
  } }));
const voiceSurface = vi.hoisted(() => ({ current: null as null | { interactionLayer: { blocksUnderlyingActions: boolean } } }));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({ useVoiceSurfaceMetadata: () => voiceSurface.current,
  getVoiceSurfaceMetadata: () => voiceSurface.current, usePublishVoiceSurfaceMetadata: () => undefined }));
describe("native drawer resume admission", () => {
  it("readmits after an accepted privacy release without a native event and rejects old choices", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__");
    bridge.platform = "ios"; bridge.documentId = crypto.randomUUID();
    privacy.state = { generation: 0, shielded: false, appIsActive: true, cause: "inactive" };
    privacy.epoch = 0;
    publishValidatedAuthSessionOwner("synthetic-resume-owner");
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    Object.defineProperty(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", { configurable: true, value: { contractVersion: 1, enabled: true } });
    drawerBridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true, wholePresentation: true,
      historyActions: true, generation: 0, isolated: false });
    drawerBridge.apply.mockReset().mockImplementation(async state => ({ ...state, phase: "active" }));
    drawerBridge.retire.mockReset().mockImplementation(async identity => ({ ...identity, phase: "retired", updateSequence: 1, privacyGeneration: privacy.state.generation }));
    drawerBridge.confirmChoice.mockReset().mockResolvedValue({ valid: true });
    const action = vi.fn();
    function Drawer() {
      const phase = useNativeDrawerPresentation({ family: "history", owner: "synthetic-resume-owner",
        vaultEpoch: snapshotVaultSessionEpoch(), ready: true, open: true, title: "Public samples",
        project: () => ({ sections: [{ id: "samples", rows: [{ id: "sample", label: "Sample chat", enabled: true }] }],
          actions: { rows: new Map([["sample", action]]), open: vi.fn(), close: vi.fn() } }) });
      return <output>{phase}</output>;
    }
    const view = render(<Drawer />);
    try {
      await waitFor(() => expect(view.getByText("native")).toBeInTheDocument());
      const old = drawerBridge.apply.mock.calls[0][0];
      const transition = (shielded: boolean, appIsActive: boolean, nativeEvent: boolean) => act(() => {
        privacy.state = { generation: 1, shielded, appIsActive, cause: "inactive" };
        privacy.epoch++;
        privacy.observations.forEach(callback => callback());
        if (nativeEvent) privacy.callbacks.forEach(callback => callback(privacy.state));
      });
      transition(true, false, true);
      await waitFor(() => expect(drawerBridge.retire).toHaveBeenCalledOnce());
      transition(true, true, true);
      expect(drawerBridge.apply).toHaveBeenCalledOnce();
      transition(false, true, false); // Auth validation receipt, no listener event.
      await waitFor(() => expect(drawerBridge.apply).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(view.getByText("native")).toBeInTheDocument());
      const next = drawerBridge.apply.mock.calls[1][0];
      expect(next.privacyGeneration).toBe(1);
      expect(next.revision).toBeGreaterThan(old.revision);
      const emit = (state: NativeDrawerProjection, sequence: number) => act(() => {
        drawerBridge.listeners.get("choice")?.forEach(callback => callback({ ...state,
          action: "row", rowId: "sample", sequence, interactionGeneration: 1 }));
      });
      emit(old, 1);
      expect(drawerBridge.confirmChoice).not.toHaveBeenCalled();
      emit(next, 2);
      await waitFor(() => expect(action).toHaveBeenCalledOnce());
    } finally {
      view.unmount();
      await act(async () => { await Promise.resolve(); });
      privacy.state = { generation: 0, shielded: false, appIsActive: true, cause: "inactive" }; privacy.epoch = 0;
      publishValidatedAuthSessionOwner(null);
      if (original) Object.defineProperty(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", original);
      else Reflect.deleteProperty(window, "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__");
    }
  });
});
describe("private native drawer action boundary", () => {
  it("selects recovery before discovery unless the wrapper explicitly bootstraps qualification", () => {
    const key = "__HUSHH_NATIVE_DRAWER_BOOTSTRAP__";
    const original = Object.getOwnPropertyDescriptor(window, key);
    const platform = bridge.platform;
    try {
      bridge.platform = "ios";
      Reflect.deleteProperty(window, key);
      expect(nativeDrawersPlatformEligible()).toBe(false);
      Object.defineProperty(window, key, { configurable: true, value: { contractVersion: 1, enabled: false } });
      expect(nativeDrawersPlatformEligible()).toBe(false);
      Object.defineProperty(window, key, { configurable: true, value: { contractVersion: 1, enabled: true } });
      expect(nativeDrawersPlatformEligible()).toBe(true);
      bridge.platform = "android";
      expect(nativeDrawersPlatformEligible()).toBe(false);
    } finally {
      bridge.platform = platform;
      if (original) Object.defineProperty(window, key, original); else Reflect.deleteProperty(window, key);
    }
  });
  const state = (): NativeDrawerProjection => ({ documentId: "public-document", ownerEpoch: "opaque-owner", ownerGeneration: 1, revision: 1,
    family: "history", updateSequence: 1, privacyGeneration: 0, title: "Public samples", open: true,
    enabled: true, backEnabled: false, appearance: "light", accentHex: "#007aff", foregroundHex: "#000000",
    sections: [{ id: "today", title: "Today", rows: [{ id: "row-handle", label: "Weekend ideas", enabled: true }] }] });
  const choice = (): NativeDrawerChoice => ({ documentId: "public-document", ownerEpoch: "opaque-owner", ownerGeneration: 1, revision: 1,
    family: "history", updateSequence: 1, privacyGeneration: 0, sequence: 1, interactionGeneration: 1, action: "row", rowId: "row-handle" });

  it("keeps native Profile groups and available actions identical to the shared roster", () => {
    const actions = Object.fromEntries(profileMenuGroups(true).flatMap(group => group.entries.map(entry => [entry.id, vi.fn()]))) as ProfileMenuActions;
    for (const local of [false, true]) {
      const groups = profileMenuGroups(local);
      const projected = projectNativeProfileMenu("Public sample", "sample@example.test", true, groups, actions, vi.fn());
      expect(projected.sections.slice(1).map(section => [section.id, section.title, section.rows.map(row => row.id)]))
        .toEqual(groups.map(group => [group.id, group.title, group.entries.map(entry => entry.id)]));
      expect(projected.sections.slice(1).map(section => section.title)).toEqual(["Your settings", "Legal", "Account access"]);
      expect(projected.actions.rows.has("developer-tools")).toBe(local);
      expect(projected.actions.rows.get("identity")).toBe(actions.account);
      for (const group of groups) for (const entry of group.entries) {
        expect(projected.actions.rows.get(entry.id)).toBe(actions[entry.id]);
        expect(actions[entry.id]).not.toHaveBeenCalled();
      }
      const projection = { ...state(), family: "profile" as const, sections: projected.sections };
      expect(validNativeDrawerProjection(projection)).toBe(true);
      for (const field of [{ iconHex: "url(https://example.test)" }, { chevron: "true" }, { trailing: "a".repeat(33) }]) {
        expect(validNativeDrawerProjection({ ...projection, sections: [{ id: "invalid", rows: [
          { ...projected.sections[1].rows[0], ...field } as NativeDrawerProjection["sections"][number]["rows"][number],
        ] }] })).toBe(false);
      }
    }
  });

  it("bounds Profile content handoff metadata without changing action authority", () => {
    const menu = { ...state(), family: "profile" as const, surfaceOpen: true };
    expect(validNativeDrawerProjection(menu)).toBe(true);
    const detail = { ...menu, open: false };
    expect(validNativeDrawerProjection(detail)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...choice(), family: "profile" }, detail)).toBe(false);
    for (const invalid of [
      { ...menu, surfaceOpen: false },
      { ...menu, surfaceOpen: "true" },
      { ...menu, family: "history" },
    ]) expect(validNativeDrawerProjection(invalid as NativeDrawerProjection)).toBe(false);
    expect(validNativeDrawerProjection({ ...menu, open: false, surfaceOpen: false })).toBe(true);
  });

  it("admits bounded raster portraits only in authored private Profile headers", () => {
    const row = { id: "identity", label: "Public sample", enabled: true, portrait: true,
      portraitData: "data:image/jpeg;base64,/9j/2Q==" };
    const portrait = { ...state(), family: "profile" as const,
      sections: [{ id: "identity-section", rows: [row] }] };
    expect(validNativeDrawerProjection(portrait)).toBe(true);
    for (const change of [{ portraitData: "https://provider.example.test/photo.jpg" },
      { portraitData: "data:image/svg+xml;base64,PHN2Zy8+" }, { portraitData: "x".repeat(100_001) },
      { portraitData: 42 }, { portrait: false }, { options: [] }]) {
      expect(validNativeDrawerProjection({ ...portrait,
        sections: [{ id: "identity-section", rows: [{ ...row, ...change }] }] } as never)).toBe(false);
    }
    expect(validNativeDrawerProjection({ ...portrait, family: "history" })).toBe(false);
    expect(validNativeDrawerProjection({ ...portrait, sections: [{ id: "arbitrary", rows: [row] }] })).toBe(false);
    expect(validNativeDrawerProjection({ ...portrait, sections: [{ id: "account-portrait", rows: [{ ...row, id: "account-photo" }] }] })).toBe(true);
    const fence = new NativeDrawerChoiceFence(portrait);
    fence.retire();
    expect(fence.allows({ ...choice(), family: "profile", rowId: "identity" })).toBe(false);
  });

  it("admits only the active native Profile destination and fences an Account round trip", async () => {
    const root = { ...state(), family: "profile" as const, surfaceOpen: true, backEnabled: true };
    const account: NativeDrawerProjection = { ...root, profileDestinationId: "account-first", profileStack: [
      { id: "account", title: "Your account", sections: [{ id: "account-details", rows: [
        { id: "edit-name", label: "Display name", enabled: true },
        { id: "mail", label: "Mail", enabled: true, readOnly: true },
      ] }] },
    ] };
    expect(validNativeDrawerProjection(account)).toBe(true);
    const payoutPage = (id: import("@/lib/capacitor/native-drawers").NativeProfilePage["id"]) => ({ id, title: "Synthetic payouts", sections: [] });
    const payout = { ...account, profileStack: [payoutPage("payouts"), payoutPage("payout-activity"), payoutPage("payout-receipt-1"), payoutPage("payout-receipt-2")] };
    expect(validNativeDrawerProjection(payout)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...choice(), family: "profile", action: "ancestor", rowId: "payouts" }, payout)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...choice(), family: "profile", action: "ancestor", rowId: "account" }, payout)).toBe(false);
    expect(validNativeDrawerProjection({ ...payout, profileStack: [payoutPage("payouts"), payoutPage("account-delete")] })).toBe(false);
    expect(validNativeDrawerProjection({ ...payout, profileStack: [payoutPage("payouts"), payoutPage("payout-receipt-2")] })).toBe(false);
    expect(validNativeDrawerProjection({ ...account, profileStack: [payoutPage("account"), payoutPage("payout-receipt-1")] })).toBe(false);
    const memory = { ...account, profileStack: ["memory", "memory-domain", "memory-section", "memory-entity", "memory-confirm"].map(id => ({ id, title: "Synthetic memory", sections: [] })) } as NativeDrawerProjection;
    expect(validNativeDrawerProjection(memory)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...choice(), family: "profile", action: "ancestor", rowId: "memory-section" }, memory)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...choice(), family: "profile", action: "ancestor", rowId: "account" }, memory)).toBe(false);
    expect(validNativeDrawerProjection({ ...memory, profileStack: [payoutPage("memory"), payoutPage("memory-confirm")] })).toBe(false);
    expect(validNativeDrawerProjection({ ...memory, profileStack: [payoutPage("memory"), payoutPage("account-delete")] })).toBe(false);
    const memorySearch = { ...memory, profileStack: [{ ...payoutPage("memory"), memorySearch: { id: "private-memory-search", query: "Synthetic" } }] };
    expect(validNativeDrawerProjection(memorySearch)).toBe(true);
    expect(validNativeDrawerProjection({ ...memorySearch, profileStack: [{ ...memorySearch.profileStack[0]!, memorySearch: null }] } as never)).toBe(false);
    expect(nativeDrawerChoiceAllowed({ ...choice(), family: "profile", rowId: "private-memory-search", text: "Category" }, memorySearch)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...choice(), family: "profile", rowId: "private-memory-search", text: "a".repeat(257) }, memorySearch)).toBe(false);
    expect(validNativeDrawerProjection({ ...memorySearch, profileStack: [{ ...memorySearch.profileStack[0]!, id: "account" }] })).toBe(false);
    const event = { ...choice(), family: "profile" as const, rowId: "edit-name" };
    expect(nativeDrawerChoiceAllowed(event, account)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...event, rowId: root.sections[0].rows[0].id }, account)).toBe(false);
    expect(nativeDrawerChoiceAllowed({ ...event, rowId: "mail" }, account)).toBe(false);
    expect(validNativeDrawerProjection({ ...account, profileDestinationId: undefined })).toBe(false);
    const locked = { ...account, navigationLocked: true };
    expect(validNativeDrawerProjection(locked)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...event, action: "close", rowId: undefined }, locked)).toBe(false);
    expect(nativeDrawerChoiceAllowed({ ...event, action: "back", rowId: undefined }, locked)).toBe(false);
    expect(nativeDrawerChoiceAllowed(event, locked)).toBe(true);
    expect(validNativeDrawerProjection({ ...account, profileStack: [{ ...account.profileStack![0], id: "arbitrary-route" }] } as never)).toBe(false);
    const fence = new NativeDrawerChoiceFence(root);
    fence.update(account);
    const reply = deferred<{ valid: boolean }>();
    const stale = fence.consume(event, () => reply.promise, () => true);
    fence.update({ ...root, profileStack: [], updateSequence: 2 });
    fence.update({ ...account, profileDestinationId: "account-returned", updateSequence: 3 });
    reply.resolve({ valid: true });
    expect(await stale).toBe(false);
    expect(fence.allows({ ...event, sequence: 2, updateSequence: 3 })).toBe(true);

    const name = { ...publicNameScene(), destinationId: "account-first" };
    const nameFence = new NativeProfileNameFence(name);
    expect(nameFence.update(name)).toBe(true);
    expect(nameFence.update({ ...name, updateSequence: 2, destinationId: "account-returned" })).toBe(false);
    expect(nameFence.allows({ ...name, sequence: 1, editRevision: 0, action: "save", destinationId: "account-returned" })).toBe(false);
    const privacy = projectNativeLegalDocument("privacy").document;
    const terms = projectNativeLegalDocument("terms").document;
    const legal = (document: typeof privacy, updateSequence: number): NativeDrawerProjection => ({ ...root, updateSequence,
      profileDestinationId: `visit-${document.type}`, profileStack: [
        { id: "legal", title: "Legal", sections: [] },
        { id: document.type, title: "Document", sections: [], legalDocument: document },
      ] });
    expect(validNativeDrawerProjection(legal(privacy, 4))).toBe(true);
    expect(validNativeDrawerProjection({ ...legal(privacy, 4), profileStack: legal(privacy, 4).profileStack!.slice(1) })).toBe(true);
    const privacyLink = { ...event, updateSequence: 4, sequence: 3, rowId: privacy.related.actionId };
    expect(nativeDrawerChoiceAllowed(privacyLink, legal(privacy, 4))).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...privacyLink, rowId: "https://example.com" }, legal(privacy, 4))).toBe(false);
    fence.update(legal(privacy, 4));
    const linkReply = deferred<{ valid: boolean }>();
    const oldLink = fence.consume(privacyLink, () => linkReply.promise, () => true);
    fence.update(legal(terms, 5)); linkReply.resolve({ valid: true });
    expect(await oldLink).toBe(false);
    expect(nativeDrawerChoiceAllowed({ ...privacyLink, updateSequence: 5 }, legal(terms, 5))).toBe(false);
  });

  it("shares one opaque auth/vault boundary across families and never resets revisions on remount", () => {
    publishValidatedAuthSessionOwner("synthetic-first-owner");
    const history = createNativeDrawerIdentity("history")!;
    const profile = createNativeDrawerIdentity("profile")!;
    expect(profile.ownerEpoch).toBe(history.ownerEpoch);
    expect(profile.ownerGeneration).toBe(history.ownerGeneration);
    expect(profile.revision).toBeGreaterThan(history.revision);
    expect(createNativeDrawerIdentity("history")!.revision).toBeGreaterThan(profile.revision);
    advanceVaultSessionEpoch();
    expect(nativeDrawerOwnerIsCurrent(history)).toBe(false);
    const renewed = createNativeDrawerIdentity("profile")!;
    expect(renewed.ownerGeneration).toBeGreaterThan(profile.ownerGeneration);
    publishValidatedAuthSessionOwner("synthetic-second-owner");
    expect(nativeDrawerOwnerIsCurrent(renewed)).toBe(false);
    const changed = createNativeDrawerIdentity("history")!;
    expect(changed.ownerGeneration).toBeGreaterThan(renewed.ownerGeneration);
    expect(JSON.stringify(changed)).not.toContain("synthetic-second-owner");
    publishValidatedAuthSessionOwner(null);
    expect(createNativeDrawerIdentity("profile")).toBeNull();
    expect(nativeDrawerOwnerIsCurrent(changed)).toBe(false);
  });

  it("keeps One's native profile isolated from the account Profile and rejects unsupported wrappers", async () => {
    const account = state();
    const agent = { ...account, family: "agent-profile" as const };
    expect(validNativeDrawerProjection(agent)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...choice(), family: "profile" }, agent)).toBe(false);
    const plugin = { getCapabilities: vi.fn().mockResolvedValue({ contractVersion: 1, supported: true, wholePresentation: true }),
      addListener: vi.fn(), retire: vi.fn() };
    const presentation = new NativeDrawerPresentation(agent, plugin as unknown as HushhNativeDrawersPlugin, () => true, vi.fn());
    expect(await presentation.listen()).toBe(false);
    expect(plugin.addListener).not.toHaveBeenCalled();
  });

  it("admits only authored rename snapshots and rejects text on other actions", () => {
    const projection = state();
    projection.sections = [{ id: "history", rows: [{ id: "select", label: "Public chat", enabled: true,
      renameActionId: "rename", deleteActionId: "delete" }] }];
    expect(validNativeDrawerProjection(projection)).toBe(true);
    expect(nativeDrawerChoiceAllowed({ ...choice(), rowId: "rename", text: "Public revised title" }, projection)).toBe(true);
    for (const text of [undefined, " ", "a".repeat(161)]) {
      expect(nativeDrawerChoiceAllowed({ ...choice(), rowId: "rename", text }, projection)).toBe(false);
    }
    expect(nativeDrawerChoiceAllowed({ ...choice(), rowId: "delete", text: "not admitted" }, projection)).toBe(false);
    expect(nativeDrawerChoiceAllowed({ ...choice(), rowId: "select", text: "not admitted" }, projection)).toBe(false);
    const duplicate = { ...projection, sections: [{ id: "history", rows: [{ ...projection.sections[0].rows[0], renameActionId: "select" }] }] };
    expect(validNativeDrawerProjection(duplicate)).toBe(false);
  });

  it("requires current authority after awaited confirmation and consumes one operation once", async () => {
    const projection = state();
    const fence = new NativeDrawerChoiceFence(projection);
    expect(fence.update(projection)).toBe(true);
    const operation = vi.fn();
    const confirmed = () => Promise.resolve({ valid: true });
    const result = await Promise.all([fence.consume(choice(), confirmed, () => true, operation),
      fence.consume(choice(), confirmed, () => true, operation)]);
    expect(result).toEqual([true, false]);
    expect(operation).toHaveBeenCalledOnce();
    expect(await fence.consume({ ...choice(), sequence: 2, rowId: "not-authored" }, confirmed, () => true, operation)).toBe(false);
    expect(await fence.consume({ ...choice(), sequence: 2, ownerEpoch: "departed-owner" }, confirmed, () => true, operation)).toBe(false);
  });

  it("withdraws pending choices on binding update or retirement, without automatic replay", async () => {
    const projection = state();
    const fence = new NativeDrawerChoiceFence(projection);
    fence.update(projection);
    let finish!: (result: { valid: boolean }) => void;
    const confirmation = new Promise<{ valid: boolean }>(resolve => { finish = resolve; });
    const operation = vi.fn();
    const pending = fence.consume(choice(), () => confirmation, () => true, operation);
    fence.update({ ...projection, updateSequence: 2, enabled: false });
    finish({ valid: true });
    expect(await pending).toBe(false);
    expect(operation).not.toHaveBeenCalled();
    fence.retire();
    expect(fence.update({ ...projection, updateSequence: 3 })).toBe(false);
    const duplicateIds = { ...projection, sections: [{ id: "row-handle", rows: projection.sections[0].rows }] };
    expect(validNativeDrawerProjection(duplicateIds)).toBe(false);
    expect(validNativeDrawerProjection({ ...projection, accentHex: "#acf", foregroundHex: "#223344aa" })).toBe(true);
    expect(validNativeDrawerProjection({ ...projection, ...{ undeclaredPayload: "synthetic" } })).toBe(false);
    expect(validNativeDrawerProjection({ ...projection, sections: [{ ...projection.sections[0], rows: [
      { ...projection.sections[0].rows[0], ...{ undeclaredPayload: "synthetic" } },
    ] }] })).toBe(false);
  });

  function presentationBridge() {
    const listeners = new Set<(event: NativeDrawerChoice) => void>();
    const isolationListeners = new Set<(event: NativeDrawerIsolation) => void>();
    const readmissionListeners = new Set<(event: NativeDrawerReadmission) => void>();
    const completionListeners = new Set<(event: NativeDrawerPresentationState) => void>();
    let isolation = { ...nativeDrawerIsolation() };
    const remove = vi.fn(async () => undefined);
    const apply = vi.fn(async (projection: NativeDrawerProjection) => ({ ...projection, phase: "active" as const }));
    const retire = vi.fn(async () => ({ ...state(), phase: "retired" as const }));
    const plugin: HushhNativeDrawersPlugin = {
      getCapabilities: async () => ({ contractVersion: 1, supported: true, wholePresentation: true, ...isolation }),
      apply, retire, confirmChoice: vi.fn(async () => ({ valid: true })),
      addListener: async (name: "choice" | "isolationChanged" | "readmissionRequested" | "presentationSettled", callback: ((event: NativeDrawerChoice) => void) | ((event: NativeDrawerIsolation) => void) | ((event: NativeDrawerReadmission) => void) | ((event: NativeDrawerPresentationState) => void)) => {
        if (name === "choice") listeners.add(callback as (event: NativeDrawerChoice) => void);
        else if (name === "readmissionRequested") readmissionListeners.add(callback as (event: NativeDrawerReadmission) => void);
        else if (name === "presentationSettled") completionListeners.add(callback as (event: NativeDrawerPresentationState) => void);
        else isolationListeners.add(callback as (event: NativeDrawerIsolation) => void);
        return { remove: async () => { listeners.delete(callback as (event: NativeDrawerChoice) => void);
          readmissionListeners.delete(callback as (event: NativeDrawerReadmission) => void);
          completionListeners.delete(callback as (event: NativeDrawerPresentationState) => void);
          isolationListeners.delete(callback as (event: NativeDrawerIsolation) => void); await remove(); } };
      },
    };
    return { plugin, apply, retire, remove, emit: (event: NativeDrawerChoice) => listeners.forEach(callback => callback(event)),
      readmit: (event: NativeDrawerReadmission) => readmissionListeners.forEach(callback => callback(event)),
      complete: (event: NativeDrawerPresentationState) => completionListeners.forEach(callback => callback(event)),
      isolate: (isolated: boolean, notify = true) => {
        isolation = { generation: isolation.generation + 1, isolated };
        if (notify) isolationListeners.forEach(callback => callback(isolation));
      } };
  }

  it("transfers destination coverage only after current native completion, including completion before its apply receipt", async () => {
    const bridge = presentationBridge();
    const capability = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capability, presentationCompletion: true });
    bridge.plugin.getPresentationState = vi.fn(async () => ({ ...state(), phase: "active" as const, valid: true as const, settled: false }));
    const presented = vi.fn();
    const projection = state();
    const presentation = new NativeDrawerPresentation(projection, bridge.plugin, () => true, vi.fn(), presented);
    const actions = { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close: vi.fn() };
    await presentation.listen();
    presentation.publish(projection, actions);
    await waitFor(() => expect(bridge.plugin.getPresentationState).toHaveBeenCalledOnce());
    expect(presented).not.toHaveBeenCalled(); // The old admission-only implementation fails here.
    const completed = { ...projection, phase: "active" as const, settled: true };
    bridge.complete({ ...completed, ownerEpoch: "retired-owner" });
    bridge.complete({ ...completed, privacyGeneration: 5 });
    expect(presented).not.toHaveBeenCalled();
    bridge.complete(completed); bridge.complete(completed);
    expect(presented).toHaveBeenCalledTimes(1);

    const next = { ...projection, updateSequence: 2, appearance: "dark" as const };
    const receipt = deferred<NativeDrawerProjection & { phase: "active" }>();
    bridge.apply.mockImplementationOnce(() => receipt.promise);
    bridge.plugin.getPresentationState = vi.fn(async () => ({ ...next, phase: "active" as const, valid: true as const, settled: true }));
    presentation.publish(next, actions);
    bridge.complete({ ...next, phase: "active", settled: true });
    expect(presented).toHaveBeenCalledTimes(1);
    receipt.resolve({ ...next, phase: "active" });
    await waitFor(() => expect(presented).toHaveBeenCalledTimes(2));
    bridge.complete(completed);
    expect(presented).toHaveBeenLastCalledWith(next);
    await presentation.retire();
    bridge.complete({ ...next, phase: "active", settled: true });
    expect(presented).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("uses targeted readback after uncertain retirement, releasing fallback only for actual disappearance=%s", async gone => {
    const bridge = presentationBridge();
    const capability = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capability, presentationCompletion: true });
    bridge.plugin.getPresentationState = vi.fn(async () => ({ ...state(), phase: "active" as const, valid: true as const, settled: true }));
    const phases = vi.fn();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, phases);
    await presentation.listen();
    presentation.publish(state(), { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close: vi.fn() });
    await waitFor(() => expect(bridge.plugin.getPresentationState).toHaveBeenCalledOnce());
    bridge.retire.mockRejectedValueOnce(new Error("Synthetic lost receipt"));
    bridge.plugin.getPresentationState = vi.fn(async () => ({ ...state(),
      phase: gone ? "retired" as const : "active" as const, valid: true as const, settled: true }));
    expect(await presentation.retire()).toBe(gone);
    expect(bridge.retire).toHaveBeenCalledOnce();
    expect(bridge.plugin.getPresentationState).toHaveBeenCalledOnce();
    expect(phases).toHaveBeenLastCalledWith(gone ? "retired" : "quarantined");
    expect(bridge.plugin.confirmChoice).not.toHaveBeenCalled();
  });

  it.each([
    ["account", false], ["account", true], ["support", false], ["support", true],
  ] as const)("quarantines an uncertain %s choice unless its destination was superseded=%s", async (family, superseded) => {
    const bridge = presentationBridge();
    const capabilities = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capabilities, profileNavigationStack: true });
    const confirmation = deferred<{ valid: boolean }>();
    vi.mocked(bridge.plugin.confirmChoice).mockImplementationOnce(() => confirmation.promise);
    bridge.plugin.settleChoice = vi.fn(async () => ({ valid: false }));
    const account: NativeDrawerProjection = { ...state(), family: "profile", surfaceOpen: true, backEnabled: family === "account",
      ...(family === "account" ? { profileDestinationId: "account-first", profileStack: [{ id: "account", title: "Your account", sections: [] }] }
        : { profileStack: [] }) };
    const phases = vi.fn(), back = vi.fn();
    const presentation = new NativeDrawerPresentation(account, bridge.plugin, () => true, phases);
    const actions = { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close: vi.fn(), back };
    await presentation.listen();
    presentation.publish(account, actions);
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    bridge.emit({ ...choice(), family: "profile", action: family === "account" ? "back" : "row", rowId: family === "account" ? undefined : "row-handle" });
    await waitFor(() => expect(bridge.plugin.confirmChoice).toHaveBeenCalledOnce());
    presentation.publish({ ...account, updateSequence: 2, appearance: "dark", ...(family === "account"
      ? { profileDestinationId: superseded ? "account-returned" : "account-first" }
      : { ...(superseded ? { profileSupportDestinationId: "support-next" } : {}) }) }, actions);
    await waitFor(() => expect(bridge.apply).toHaveBeenCalledTimes(2));
    confirmation.resolve({ valid: false });
    await waitFor(() => expect(bridge.plugin.settleChoice).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(phases.mock.calls.some(([phase]) => phase === "quarantined")).toBe(!superseded);
    expect(back).not.toHaveBeenCalled();
    await presentation.retire();
  });

  it.each(["content", "delivery", "pending-apply", "visit", "lock-cycle"] as const)("fences a committed native Back through a %s update without replaying it", async update => {
    const bridge = presentationBridge();
    const capabilities = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capabilities, profileNavigationStack: true, compatibleBackRefreshes: true });
    bridge.plugin.settleChoice = vi.fn(async () => ({ valid: true }));
    const confirmation = deferred<{ valid: boolean }>();
    vi.mocked(bridge.plugin.confirmChoice).mockReturnValueOnce(confirmation.promise);
    const projection: NativeDrawerProjection = { ...state(), family: "profile", surfaceOpen: true, backEnabled: true,
      profileDestinationId: "memory-live-first", profileStack: [
        { id: "memory", title: "Memory", sections: [] }, { id: "memory-live", title: "Live memory", sections: [] },
      ] };
    const oldBack = vi.fn(), currentBack = vi.fn(), phases = vi.fn();
    const actions = { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close: vi.fn(), back: oldBack, root: vi.fn() };
    const presentation = new NativeDrawerPresentation(projection, bridge.plugin, () => true, phases);
    await presentation.listen();
    presentation.publish(projection, actions);
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    const back = { ...choice(), family: "profile" as const, action: "back" as const, rowId: undefined };
    const applyReceipt = deferred<NativeDrawerProjection & { phase: "active" }>();
    if (update === "pending-apply") {
      await act(async () => { await Promise.resolve(); });
      bridge.apply.mockImplementationOnce(() => applyReceipt.promise);
      bridge.emit(back);
    } else if (update !== "delivery") {
      bridge.emit(back);
      await waitFor(() => expect(bridge.plugin.confirmChoice).toHaveBeenCalledOnce());
    }
    presentation.publish({ ...projection, updateSequence: 2, appearance: "dark",
      ...(update === "visit" ? { profileDestinationId: "memory-live-reopened" } : {}),
      ...(update === "lock-cycle" ? { navigationLocked: true } : {}) }, { ...actions, back: currentBack });
    await waitFor(() => expect(bridge.apply).toHaveBeenCalledTimes(2));
    if (update === "pending-apply") {
      // A new dispatch can begin after choose captures the previous drain.
      // Neither rejection nor confirmation is valid before its apply receipt.
      expect(bridge.plugin.settleChoice).not.toHaveBeenCalled();
      expect(bridge.plugin.confirmChoice).not.toHaveBeenCalled();
      applyReceipt.resolve({ ...projection, updateSequence: 2, appearance: "dark", phase: "active" });
      await waitFor(() => expect(bridge.plugin.confirmChoice).toHaveBeenCalledOnce());
    }
    if (update === "lock-cycle") {
      presentation.publish({ ...projection, updateSequence: 3 }, { ...actions, back: currentBack });
      await waitFor(() => expect(bridge.apply).toHaveBeenCalledTimes(3));
    }
    if (update === "delivery") {
      bridge.emit(back);
      await waitFor(() => expect(bridge.plugin.confirmChoice).toHaveBeenCalledOnce());
    }
    confirmation.resolve({ valid: true });
    await waitFor(() => expect(bridge.plugin.settleChoice).toHaveBeenCalledOnce());
    expect(oldBack).not.toHaveBeenCalled();
    const expected = update === "visit" || update === "lock-cycle" ? 0 : 1;
    expect(currentBack).toHaveBeenCalledTimes(expected);
    bridge.emit(back);
    await act(async () => { await Promise.resolve(); });
    expect(currentBack).toHaveBeenCalledTimes(expected);
    await presentation.retire();
  });

  it.each(["rejected", "accepted", "locked", "reopened", "legacy", "missing-port"] as const)("honors the Close settlement contract for %s without replay", async outcome => {
    const bridge = presentationBridge();
    const capability = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capability, terminalRefreshes: true, closeSettlements: outcome !== "legacy" });
    bridge.plugin.settleChoice = vi.fn(async () => ({ valid: true }));
    const settlement = deferred<{ valid: boolean }>();
    if (outcome === "reopened") vi.mocked(bridge.plugin.settleChoice).mockReturnValueOnce(settlement.promise);
    if (outcome === "missing-port") bridge.plugin.settleChoice = undefined;
    const projection: NativeDrawerProjection = { ...state(), family: "profile", surfaceOpen: true, profileStack: [] };
    const close = vi.fn(() => outcome === "accepted" || outcome === "reopened");
    const actions = { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close };
    const phases = vi.fn();
    const presentation = new NativeDrawerPresentation(projection, bridge.plugin, () => true, phases);
    if (outcome === "missing-port") {
      expect(await presentation.listen()).toBe(false);
      expect(bridge.apply).not.toHaveBeenCalled();
      expect(phases).toHaveBeenCalledWith("retired");
      expect(close).not.toHaveBeenCalled();
      return;
    }
    await presentation.listen(); presentation.publish(projection, actions);
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    await act(async () => { await Promise.resolve(); });
    const event = { ...choice(), family: "profile" as const, action: "close" as const, rowId: undefined };
    bridge.emit(event);
    if (outcome === "locked") presentation.publish({ ...projection, updateSequence: 2, navigationLocked: true }, actions);
    if (outcome === "legacy") {
      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(bridge.plugin.settleChoice).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(bridge.plugin.settleChoice).toHaveBeenCalledWith(expect.objectContaining({ sequence: event.sequence, success: outcome === "accepted" || outcome === "reopened" })));
      if (outcome === "reopened") {
        presentation.publish({ ...projection, updateSequence: 2, open: false }, actions);
        await waitFor(() => expect(bridge.apply).toHaveBeenCalledTimes(2));
        presentation.publish({ ...projection, updateSequence: 3 }, actions);
        await waitFor(() => expect(bridge.apply).toHaveBeenCalledTimes(3));
        settlement.resolve({ valid: false });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      }
      expect(close).toHaveBeenCalledTimes(outcome === "locked" ? 0 : 1);
      bridge.emit(event);
      await act(async () => { await Promise.resolve(); });
      expect(bridge.plugin.settleChoice).toHaveBeenCalledOnce();
    }
    expect(phases).not.toHaveBeenCalledWith("quarantined");
    await presentation.retire();
  });

  it("refreshes a timed-out drawer presentation once without repeating any operation", async () => {
    const bridge = presentationBridge();
    const capability = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capability, terminalReadmission: true });
    const refresh = vi.fn(() => true), close = vi.fn(), phases = vi.fn();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, phases, undefined, refresh);
    await presentation.listen();
    presentation.publish(state(), { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close });
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    const request = { ...state(), interactionGeneration: 3 };
    for (const stale of [{ ...request, ownerEpoch: "old-owner" }, { ...request, privacyGeneration: 7 },
      { ...request, updateSequence: 0 }, { ...request, interactionGeneration: NaN }]) bridge.readmit(stale);
    expect(refresh).not.toHaveBeenCalled();
    bridge.readmit(request); bridge.readmit(request);
    expect(refresh).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(bridge.plugin.confirmChoice).not.toHaveBeenCalled();
    await presentation.retire();
    bridge.readmit({ ...request, interactionGeneration: 4 });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("withdraws a timeout readmission when the feature owner no longer has authority", async () => {
    const bridge = presentationBridge();
    const capability = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capability, terminalReadmission: true });
    let current = true;
    const refresh = vi.fn(() => true), phases = vi.fn();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => current, phases, undefined, refresh);
    await presentation.listen();
    presentation.publish(state(), { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close: vi.fn() });
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    current = false;
    bridge.readmit({ ...state(), interactionGeneration: 3 });
    await waitFor(() => expect(bridge.retire).toHaveBeenCalledOnce());
    expect(refresh).not.toHaveBeenCalled();
    expect(bridge.plugin.confirmChoice).not.toHaveBeenCalled();
  });

  it("completes one emitted Close through compatible content refreshes without replaying or using obsolete authority", async () => {
    const bridge = presentationBridge();
    const capabilities = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capabilities, terminalRefreshes: true });
    const confirmation = deferred<{ valid: boolean }>();
    vi.mocked(bridge.plugin.confirmChoice).mockReturnValueOnce(confirmation.promise);
    const phases = vi.fn(), originalClose = vi.fn(), currentClose = vi.fn();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, phases);
    const actions = { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close: originalClose };
    await presentation.listen();
    presentation.publish(state(), actions);
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    const terminal = { ...choice(), action: "close" as const, rowId: undefined };
    bridge.emit(terminal);
    await waitFor(() => expect(bridge.plugin.confirmChoice).toHaveBeenCalledOnce());
    presentation.publish({ ...state(), updateSequence: 2, appearance: "dark" }, { ...actions, close: currentClose });
    await waitFor(() => expect(bridge.apply).toHaveBeenCalledTimes(2));
    confirmation.resolve({ valid: true });
    await waitFor(() => expect(currentClose).toHaveBeenCalledOnce());
    expect(originalClose).not.toHaveBeenCalled();
    bridge.emit(terminal);
    expect(currentClose).toHaveBeenCalledOnce();
    bridge.retire.mockResolvedValue({ ...state(), updateSequence: 2, phase: "retired" });
    expect(await presentation.retire()).toBe(true);

    for (const invalidation of ["privacy", "disabled", "close-reopen", "owner"] as const) {
      const fence = new NativeDrawerChoiceFence(state());
      fence.enableTerminalRefreshes();
      fence.update(state());
      const pending = deferred<{ valid: boolean }>(), operation = vi.fn();
      let currentOwner = true;
      const consume = fence.consume(terminal, () => pending.promise, () => currentOwner, operation);
      if (invalidation === "owner") currentOwner = false;
      else {
        fence.update({ ...state(), updateSequence: 2,
          privacyGeneration: invalidation === "privacy" ? 1 : 0,
          enabled: invalidation !== "disabled", open: invalidation !== "close-reopen" });
        if (invalidation === "close-reopen") fence.update({ ...state(), updateSequence: 3 });
      }
      pending.resolve({ valid: true });
      expect(await consume).toBe(false);
      expect(operation).not.toHaveBeenCalled();
    }
    for (const action of ["close", "row", "back"] as const) {
      const projection = { ...state(), backEnabled: true };
      const fence = new NativeDrawerChoiceFence(projection);
      if (action !== "close") fence.enableTerminalRefreshes();
      fence.update(projection);
      const pending = deferred<{ valid: boolean }>(), operation = vi.fn();
      const consume = fence.consume({ ...choice(), action, rowId: action === "row" ? "row-handle" : undefined },
        () => pending.promise, () => true, operation);
      fence.update({ ...projection, updateSequence: 2, appearance: "dark" });
      pending.resolve({ valid: true });
      expect(await consume).toBe(false); // Older wrappers and Row/Back remain strict.
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it.each(["vault", "payouts"] as const)("rejects busy %s native Back instead of acknowledging a pop the route did not commit", async family => {
    const bridge = presentationBridge();
    const capabilities = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capabilities, profileNavigationStack: true });
    bridge.plugin.settleChoice = vi.fn(async () => ({ valid: true }));
    const projection: NativeDrawerProjection = { ...state(), family: "profile", backEnabled: true, surfaceOpen: true,
      profileDestinationId: "busy-native-visit", profileStack: (family === "vault" ? ["security", "vault", "vault-remove"] : ["payouts", "payout-activity", "payout-receipt-1"]).map(id => ({
        id: id as import("@/lib/capacitor/native-drawers").NativeProfilePage["id"], title: "Synthetic navigation", sections: [],
      })) };
    const phases = vi.fn(), back = vi.fn(() => false);
    const presentation = new NativeDrawerPresentation(projection, bridge.plugin, () => true, phases);
    await presentation.listen();
    expect(presentation.publish(projection, { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close: vi.fn(), back, root: vi.fn(), ancestor: vi.fn() })).toBe(true);
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    const event = { ...choice(), family: "profile" as const, action: "back" as const, rowId: undefined };
    bridge.emit(event);
    await waitFor(() => expect(bridge.plugin.settleChoice).toHaveBeenCalledWith({ ...presentation.identity, sequence: 1, privacyGeneration: 0, success: false }));
    bridge.emit(event);
    expect(back).toHaveBeenCalledOnce();
    bridge.plugin.retire = async () => ({ ...projection, phase: "retired" });
    await presentation.retire();
  });

  it.each([true, false])("settles a committed row once with explicit success=%s and never repeats the operation", async success => {
    const bridge = presentationBridge();
    bridge.plugin.settleChoice = vi.fn(async () => ({ valid: true }));
    const pending = deferred<void>();
    const operation = vi.fn(() => pending.promise);
    const phases = vi.fn();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, phases);
    await presentation.listen();
    presentation.publish(state(), { rows: new Map([["row-handle", operation]]), open: vi.fn(), close: vi.fn() });
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    bridge.emit(choice());
    await waitFor(() => expect(operation).toHaveBeenCalledOnce());
    expect(bridge.plugin.settleChoice).not.toHaveBeenCalled();
    bridge.emit(choice());
    if (success) pending.resolve(); else pending.reject(new Error("Synthetic operation failure"));
    await waitFor(() => expect(bridge.plugin.settleChoice).toHaveBeenCalledWith({ ...presentation.identity, sequence: 1, privacyGeneration: 0, success }));
    expect(operation).toHaveBeenCalledOnce();
    expect(bridge.plugin.settleChoice).toHaveBeenCalledOnce();
    await presentation.retire();
  });

  it.each([true, false])("does not retire a reopened drawer after an obsolete terminal acknowledgement valid=%s", async valid => {
    const bridge = presentationBridge();
    const capabilities = await bridge.plugin.getCapabilities();
    bridge.plugin.getCapabilities = async () => ({ ...capabilities, terminalRefreshes: true });
    const confirmation = deferred<{ valid: boolean }>();
    vi.mocked(bridge.plugin.confirmChoice).mockReturnValueOnce(confirmation.promise);
    const phases = vi.fn(), close = vi.fn();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, phases);
    const actions = { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close };
    await presentation.listen();
    presentation.publish(state(), actions);
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    bridge.emit({ ...choice(), action: "close", rowId: undefined });
    await waitFor(() => expect(bridge.plugin.confirmChoice).toHaveBeenCalledOnce());
    presentation.publish({ ...state(), updateSequence: 2, open: false }, actions);
    presentation.publish({ ...state(), updateSequence: 3 }, actions);
    await waitFor(() => expect(bridge.apply).toHaveBeenCalledTimes(3));
    await act(async () => { confirmation.resolve({ valid }); });
    expect(close).not.toHaveBeenCalled();
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(phases).not.toHaveBeenCalledWith("quarantined");
    bridge.retire.mockResolvedValue({ ...state(), updateSequence: 3, phase: "retired" });
    expect(await presentation.retire()).toBe(true);
  });

  it.each(["accepted", "rejected"] as const)("waits for latest admission and fences a replaced callback after %s obsolete confirmation", async outcome => {
    const bridge = presentationBridge();
    const first = deferred<ReturnType<typeof state> & { phase: "active" }>();
    bridge.apply.mockImplementationOnce(() => first.promise);
    const phases = vi.fn(), oldAction = vi.fn(), newAction = vi.fn();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, phases);
    const actions = { rows: new Map([["row-handle", oldAction]]), open: vi.fn(), close: vi.fn() };
    expect(await presentation.listen()).toBe(true);
    expect(presentation.publish(state(), actions)).toBe(true);
    expect(presentation.publish({ ...state(), updateSequence: 2 }, { ...actions, rows: new Map([["row-handle", newAction]]) })).toBe(true);
    bridge.emit(choice());
    expect(bridge.plugin.confirmChoice).not.toHaveBeenCalled();
    first.resolve({ ...state(), phase: "active" });
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    bridge.emit(choice());
    expect(bridge.plugin.confirmChoice).not.toHaveBeenCalled();
    const pending = deferred<{ valid: boolean }>();
    vi.mocked(bridge.plugin.confirmChoice).mockReturnValueOnce(pending.promise);
    bridge.emit({ ...choice(), sequence: 2, updateSequence: 2 });
    await waitFor(() => expect(bridge.plugin.confirmChoice).toHaveBeenCalledOnce());
    presentation.publish({ ...state(), updateSequence: 3, enabled: false }, actions);
    if (outcome === "accepted") pending.resolve({ valid: true });
    else pending.reject(new Error("Synthetic obsolete confirmation failure"));
    await waitFor(() => expect(bridge.apply).toHaveBeenCalledTimes(3));
    expect(newAction).not.toHaveBeenCalled();
    expect(oldAction).not.toHaveBeenCalled();
    bridge.retire.mockResolvedValue({ ...state(), updateSequence: 3, phase: "retired" });
    expect(await presentation.retire()).toBe(true);
    expect(bridge.remove).toHaveBeenCalledTimes(2);
  });

  it.each(["wrong-owner", "missing"] as const)("quarantines uncertain delivery and never restores fallback with %s retirement proof", async proof => {
    const bridge = presentationBridge();
    const cleanup = deferred<void>();
    bridge.remove.mockImplementation(() => cleanup.promise);
    bridge.retire.mockResolvedValue(proof === "missing" ? null as never : { ...state(), ownerEpoch: "replacement", phase: "retired" });
    bridge.apply.mockRejectedValueOnce(new Error("synthetic uncertain delivery"));
    const phases = vi.fn(), action = vi.fn();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, phases);
    const actions = { rows: new Map([["row-handle", action]]), open: vi.fn(), close: vi.fn() };
    await presentation.listen();
    bridge.isolate(true);
    presentation.publish(state(), actions);
    await waitFor(() => expect(phases).toHaveBeenCalledWith("quarantined"));
    expect(presentation.publish({ ...state(), updateSequence: 2 }, actions)).toBe(false);
    bridge.emit(choice());
    expect(bridge.apply).toHaveBeenCalledOnce();
    expect(bridge.plugin.confirmChoice).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(await presentation.retire()).toBe(false);
    expect(bridge.retire).toHaveBeenCalledOnce();
    expect(phases).not.toHaveBeenCalledWith("retired");
    expect(bridge.remove).toHaveBeenCalledTimes(1);
    bridge.isolate(false); // Later native privacy retirement must still update public eligibility.
    expect(nativeDrawerIsolation().isolated).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    expect(bridge.remove).toHaveBeenCalledTimes(2);
    cleanup.resolve();
  });
  it("reconciles authoritative isolation after retirement before releasing the public observer", async () => {
    const bridge = presentationBridge();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, vi.fn());
    await presentation.listen();
    presentation.publish(state(), { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close: vi.fn() });
    await waitFor(() => expect(bridge.apply).toHaveBeenCalledOnce());
    bridge.isolate(true);
    expect(nativeDrawerIsolation().isolated).toBe(true);
    bridge.retire.mockImplementation(async () => {
      bridge.isolate(false, false); // The bridge can coalesce the final notification.
      return { ...state(), phase: "retired" };
    });
    expect(await presentation.retire()).toBe(true);
    expect(nativeDrawerIsolation().isolated).toBe(false);
    expect(bridge.remove).toHaveBeenCalledTimes(2);
  });
  it("removes the acquired observer if capability catch-up hangs and never admits a premature projection", async () => {
    vi.useFakeTimers();
    try {
      const bridge = presentationBridge();
      const capability = await bridge.plugin.getCapabilities();
      vi.spyOn(bridge.plugin, "getCapabilities").mockResolvedValueOnce(capability).mockReturnValue(new Promise(() => undefined));
      const phases = vi.fn();
      const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, phases);
      const listening = presentation.listen();
      await vi.advanceTimersByTimeAsync(0);
      expect(presentation.publish(state(), { rows: new Map([["row-handle", vi.fn()]]), open: vi.fn(), close: vi.fn() })).toBe(false);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await listening).toBe(false);
      expect(bridge.apply).not.toHaveBeenCalled();
      expect(bridge.remove).toHaveBeenCalledTimes(2);
      expect(phases.mock.calls.at(-1)?.[0]).toBe("retired");
    } finally { vi.useRealTimers(); }
  });
  it("ignores obsolete confirmation rejection after confirmed retirement", async () => {
    const bridge = presentationBridge();
    const confirmation = deferred<{ valid: boolean }>();
    vi.mocked(bridge.plugin.confirmChoice).mockReturnValueOnce(confirmation.promise);
    const phases = vi.fn(), operation = vi.fn();
    const presentation = new NativeDrawerPresentation(state(), bridge.plugin, () => true, phases);
    await presentation.listen();
    presentation.publish(state(), { rows: new Map([["row-handle", operation]]), open: vi.fn(), close: vi.fn() });
    await waitFor(() => expect(phases).toHaveBeenCalledWith("active"));
    bridge.emit(choice());
    await waitFor(() => expect(bridge.plugin.confirmChoice).toHaveBeenCalledOnce());
    expect(await presentation.retire()).toBe(true);
    await act(async () => { confirmation.reject(new Error("Synthetic departed-owner failure")); });
    expect(phases.mock.calls.map(([phase]) => phase)).toEqual(["active", "retired"]);
    expect(bridge.retire).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
  });
});

const projection = { kind: "back" as const, label: "Go back", enabled: true,
  appearance: "light" as const, accentHex: "#112233", foregroundHex: "#223344",
  frame: { x: 2, y: 60, width: 44, height: 44 }, viewport: { width: 390, height: 844 } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; }
function choice(lease: NativeChromeLease, sequence = 1) { return { ...lease.projection, sequence, privacyGeneration: 0 }; }

describe("owned panel pose transport", () => {
  const pose: NativePanelPose = { documentId: "synthetic", ownerEpoch: "epoch", group: "profile", generation: 1,
    sequence: 1, privacyGeneration: 0, frame: { x: 0, y: 0, width: 390, height: 844 }, offset: 0, opacity: 1, settled: false };
  it("bounds an in-flight drag to the newest pending pose and never replays a retired delivery", async () => {
    const first = deferred<NativePanelPose>();
    const send = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async value => value);
    const failed = vi.fn();
    const writer = new NativePanelPoseWriter(send, failed);
    writer.publish(pose);
    for (let sequence = 2; sequence <= 20; sequence++) writer.publish({ ...pose, sequence, offset: sequence });
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve(pose);
    await first.promise; await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].sequence).toBe(20);
    writer.retire(); writer.publish({ ...pose, sequence: 21 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
  });
  it("quarantines mismatched ownership and uncertain receipts instead of resuming a stale panel", async () => {
    const failed = vi.fn();
    const writer = new NativePanelPoseWriter(async value => ({ ...value, ownerEpoch: "stale" }), failed);
    writer.publish(pose);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce();
    const staleRegion = new NativePanelPoseWriter(async value => ({ ...value, presentationRegionRevision: 4 }), failed);
    staleRegion.publish({ ...pose, presentationRegionRevision: 5 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(failed).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    const hung = vi.fn(() => new Promise<NativePanelPose>(() => undefined));
    const timeout = vi.fn();
    const uncertain = new NativePanelPoseWriter(hung, timeout);
    uncertain.publish(pose); uncertain.publish({ ...pose, sequence: 2 });
    await vi.advanceTimersByTimeAsync(3001);
    expect(timeout).toHaveBeenCalledOnce(); expect(hung).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("does not confirm or replay a superseded coverage receipt, but admits a fresh authored pose", async () => {
    const failed = vi.fn(), confirmed = vi.fn(), refresh = vi.fn();
    const send = vi.fn().mockImplementationOnce(async value => ({ ...value, presentationApplied: false }))
      .mockImplementation(async value => value);
    const writer = new NativePanelPoseWriter(send, failed, confirmed, refresh);
    writer.publish({ ...pose, presentationRegionRevision: 4 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(confirmed).not.toHaveBeenCalled();
    writer.publish({ ...pose, sequence: 2, presentationRegionRevision: 5 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    expect(confirmed).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    writer.retire();
  });
  it("resamples queued geometry with its own timestamp after delivery without replaying a retired frame", async () => {
    const first = deferred<NativePanelPose>();
    const send = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async value => value);
    const failed = vi.fn();
    const fresh = { ...pose, sequence: 3, offset: 0, settled: true, sampledAtMs: 102 };
    const refresh = vi.fn(() => writer.publish(fresh));
    const writer = new NativePanelPoseWriter(send, failed, undefined, refresh);
    writer.publish({ ...pose, sampledAtMs: 100 });
    writer.publish({ ...pose, sequence: 2, offset: 80, sampledAtMs: 101 });
    first.resolve(pose);
    await first.promise; await Promise.resolve(); await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual(fresh); // Includes latest terminal intent, not the aged transform.
    writer.retire();
    writer.publish({ ...fresh, sequence: 4 });
    expect(refresh).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    const delayed = deferred<NativePanelPose>();
    const nextRefresh = vi.fn();
    const retired = new NativePanelPoseWriter(() => delayed.promise, failed, undefined, nextRefresh);
    retired.publish(pose); retired.publish({ ...pose, sequence: 2 }); retired.retire();
    delayed.resolve(pose);
    await delayed.promise; await Promise.resolve(); await Promise.resolve();
    expect(nextRefresh).not.toHaveBeenCalled();
  });
});

describe("private dock event boundary", () => {
  it("samples the CSS resting seat independently of native scroll lag without accumulating displacement", () => {
    const motion = document.createElement("div"), seat = document.createElement("div");
    motion.dataset.bottomShellMotionStack = "";
    motion.append(seat); document.body.append(motion);
    vi.stubGlobal("DOMMatrixReadOnly", class {
      is2D = true; a = 1; b = 0; c = 0; d = 1; f = 0;
      constructor(value: string) { this.f = value === "matrix(1, 0, 0, 1, 0, 27.5)" ? 27.5 : 55; }
    });
    const rect = vi.spyOn(seat, "getBoundingClientRect");
    try {
      for (const offset of [27.5, 55, 27.5]) {
        motion.style.transform = `matrix(1, 0, 0, 1, 0, ${offset})`;
        rect.mockReturnValue({ x: 16, y: 700 + offset, width: 358, height: 52 } as DOMRect);
        expect(nativeDockRestingFrame(seat)).toEqual({ x: 16, y: 700, width: 358, height: 52 });
      }
      // Keyboard/reduced-motion CSS can remove the effective transform even
      // while a previous progress snapshot is nonzero. Compensate pixels only.
      motion.style.transform = "none";
      rect.mockReturnValue({ x: 16, y: 492, width: 358, height: 52 } as DOMRect);
      expect(nativeDockRestingFrame(seat)?.y).toBe(492);
    } finally { motion.remove(); rect.mockRestore(); vi.unstubAllGlobals(); }
  });

  const identity = { documentId: "dock-document", ownerEpoch: "dock-owner", revision: 1 };
  const input = (overrides: Partial<DockEvent> = {}): DockEvent => ({
    ...identity, sequence: 1, updateSequence: 1, editRevision: 1, editorRevision: 0, privacyGeneration: 0,
    context: "conversation-a", kind: "edit", text: "Hello 👋", selectionStart: 8, selectionEnd: 8, ...overrides,
  });
  it("consumes ordered private input once and rejects stale owner, conversation and edit revisions", () => {
    const fence = new DockEventFence(identity);
    expect(fence.accept(input(), "conversation-a")).toBe(true);
    expect(fence.accept(input(), "conversation-a")).toBe(false);
    expect(fence.accept(input({ sequence: 2, ownerEpoch: "older-owner" }), "conversation-a")).toBe(false);
    expect(fence.accept(input({ sequence: 2 }), "conversation-b")).toBe(false);
    expect(fence.accept(input({ sequence: 2, editorRevision: 1 }), "conversation-a", 2)).toBe(false);
    expect(fence.accept(input({ sequence: 2, editRevision: 0 }), "conversation-a")).toBe(false);
    expect(fence.accept(input({ sequence: 2, kind: "action", action: "send" }), "conversation-a")).toBe(true);
    expect(fence.accept(input({ sequence: 2, kind: "action", action: "send" }), "conversation-a")).toBe(false);
  });
  it("rejects malformed input without consuming a valid subsequent action", () => {
    const fence = new DockEventFence(identity);
    for (const invalid of [input({ sequence: NaN }), input({ text: null as unknown as string }),
      input({ selectionEnd: 100 }), input({ kind: "action", action: "transport-send" as DockEvent["action"] })]) {
      expect(fence.accept(invalid, "conversation-a")).toBe(false);
    }
    expect(fence.accept(input({ kind: "action", action: "send" }), "conversation-a")).toBe(true);
  });
  it("accepts equal-height keyboard movement but rejects stale or unbounded layout receipts", () => {
    const fence = new DockEventFence(identity);
    const viewport = { width: 390, height: 844 };
    const layout = { ...identity, updateSequence: 1, layoutSequence: 1, privacyGeneration: 0,
      viewport, frame: { x: 16, y: 700, width: 358, height: 52 } };
    expect(fence.acceptLayout(layout, 1, 0, viewport)).toBe(true);
    const moved = { ...layout, layoutSequence: 2, frame: { ...layout.frame, y: 440 } };
    expect(fence.acceptLayout(moved, 1, 0, viewport)).toBe(true);
    expect(fence.acceptLayout(layout, 1, 0, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3, ownerEpoch: "older-owner" }, 1, 0, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3 }, 2, 0, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3 }, 1, 1, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3, frame: { ...moved.frame, y: -1 } }, 1, 0, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3 }, 1, 0, { width: 844, height: 390 })).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3 }, 1, 0, viewport)).toBe(true);
  });
});

describe("private dock asynchronous submission boundary", () => {
  function Feature({ blocked, onAction, onEdit }: { blocked: boolean; onAction: NativeDockPort["onAction"]; onEdit?: (text: string) => void }) {
    const dock = useAgentDockState();
    const host = useRef<HTMLDivElement>(null);
    useNativeNavigationBlocked(blocked);
    useLayoutEffect(() => {
      dock?.setHost(host.current);
    }, [dock]);
    useNativeDockPort("text", { projection: {
      context: "synthetic-conversation", mode: "text", text: "Synthetic draft", placeholder: "Message One",
      expanded: false, editable: true, sendEnabled: true, micEnabled: true, cancelEnabled: false,
      recording: false, recordingReady: false, muted: false, supportsHold: false,
      attachments: [], attachmentRevision: 0, editorRevision: 0,
    }, onAction, onEdit });
    return <div data-agent-bar-shell><div ref={host} /><AgentDockPortal enabled visible>
      <div data-agent-dock-embedded /></AgentDockPortal><NativeAgentDock enabled /><PresentationProbe /></div>;
  }
  function PresentationProbe() {
    const ports = useNativeDockPorts();
    return <span data-testid="dock-presentation">{ports?.owned ? "reserved" : "fallback"}</span>;
  }
  function fixture(blocked: boolean, onAction: NativeDockPort["onAction"], onEdit?: (text: string) => void) {
    return <AgentDockProvider><Feature blocked={blocked} onAction={onAction} onEdit={onEdit} /></AgentDockProvider>;
  }
  function send(state: DockState): DockEvent {
    return { ...state, sequence: 1, editRevision: 0, privacyGeneration: 0, kind: "action", action: "send",
      selectionStart: 0, selectionEnd: 0 };
  }
  beforeEach(() => {
    vi.mocked(customNativePresentationEnabled).mockReturnValue(true);
    bridge.platform = "ios"; bridge.documentId = crypto.randomUUID();
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    document.documentElement.classList.remove("dark");
    dockBridge.callbacks.clear();
    dockBridge.subscribe.mockReset().mockResolvedValue(undefined);
    dockBridge.getCapabilities.mockReset().mockResolvedValue({ contractVersion: 1, supported: true });
    dockBridge.apply.mockReset().mockImplementation(async state => ({ ...state, height: 52, phase: "active" }));
    dockBridge.suspend.mockReset().mockImplementation(async state => ({ ...state, height: 52, phase: "active" }));
    dockBridge.retire.mockReset().mockImplementation(async state => ({ ...state, height: 52, phase: "retired",
      recovery: { text: "", context: "synthetic-conversation", editorRevision: 0, consumed: true } }));
    dockBridge.confirmEvent.mockReset().mockResolvedValue({ valid: true });
    dockBridge.consumeDraft.mockReset();
    dockBridge.beginEditingTransition.mockReset();
    dockBridge.snapshotDraft.mockReset();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 700, width: 350, height: 52,
      top: 700, bottom: 752, left: 20, right: 370, toJSON: () => ({}) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });
  afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve(); }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it.each([
    { shielded: false, native: false }, { shielded: true, native: false },
    { shielded: false, native: true }, { shielded: true, native: true },
  ])("retains covered dock paint and reconciles only a current committed draft ($native native; $shielded privacy changed)", async ({ shielded, native }) => {
    const snapshot = deferred<{ valid: boolean; text: string; editorRevision: number; editRevision: number }>();
    const edit = vi.fn(), action = vi.fn();
    dockBridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true, coherentPresentation: true, draftSnapshot: true });
    dockBridge.snapshotDraft.mockReturnValue(snapshot.promise);
    const view = render(fixture(false, action, edit));
    await waitFor(() => expect(dockBridge.apply).toHaveBeenCalled());
    const initial = dockBridge.apply.mock.calls.at(-1)![0] as DockState;
    let uncover: (() => void) | undefined;
    if (native) {
      let changed: ((state: NativeDrawerIsolation) => void) | undefined;
      const source = {
        getCapabilities: async () => nativeDrawerIsolation(),
        addListener: async (_: "isolationChanged", listener: (state: NativeDrawerIsolation) => void) => {
          changed = listener; return { remove: async () => undefined };
        },
      };
      const listener = await subscribeNativeDrawerIsolation(source);
      act(() => changed?.({ generation: nativeDrawerIsolation().generation + 1, isolated: true }));
      uncover = () => {
        act(() => changed?.({ generation: nativeDrawerIsolation().generation + 1, isolated: false }));
        void listener.remove();
      };
    } else view.rerender(fixture(true, action, edit));
    await waitFor(() => expect(dockBridge.snapshotDraft).toHaveBeenCalledOnce());
    if (shielded) act(() => privacy.callbacks.forEach(callback => callback({ generation: 1, shielded: true, appIsActive: false })));
    await act(async () => snapshot.resolve({ valid: true, text: "Final committed synthetic edit", editorRevision: 0, editRevision: 1 }));
    if (shielded) expect(edit).not.toHaveBeenCalled();
    else {
      expect(edit).toHaveBeenCalledWith("Final committed synthetic edit");
      await waitFor(() => expect(dockBridge.apply.mock.calls.some(([state]) =>
        state.revision === initial.revision && state.visible && !state.interactionEnabled)).toBe(true));
      expect(dockBridge.suspend).not.toHaveBeenCalled();
      expect(dockBridge.retire).not.toHaveBeenCalled();
    }
    expect(action).not.toHaveBeenCalled();
    expect(dockBridge.consumeDraft).not.toHaveBeenCalled();
    uncover?.();
  });
  it("reveals recovery controls synchronously and never admits reservations, apertures or drawer poses", async () => {
    const productionPolicy = await vi.importActual<typeof import("@/lib/capacitor/native-presentation-policy")>("@/lib/capacitor/native-presentation-policy");
    expect(productionPolicy.customNativePresentationEnabled()).toBe(false);
    vi.mocked(customNativePresentationEnabled).mockReturnValue(false);
    bridge.getCapabilities.mockReturnValue(new Promise(() => undefined));
    const back = vi.fn(), select = vi.fn();
    function Controls({ open }: { open: boolean }) {
      const focus = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
      const attach = useNativePanelPresentation("profile", "synthetic-owner", panel, open);
      const ready = useNativeFullWindowOverlayReady(open);
      return <div data-app-shell-root="true">
        <NativeShellBack label="Go back" onBack={back} owner="synthetic-owner" context="synthetic" eligible />
        <NativeChatChrome kind="agent-surface" owner="synthetic-owner" context="synthetic" eligible value="one"
          className="" focusRef={focus} onValueChange={select}><button ref={focus} onClick={() => select("puppy")}>Puppy</button></NativeChatChrome>
        <div ref={attach} data-native-panel-group="profile" data-testid="recovery-pane">{ready ? "ready" : "waiting"}</div>
      </div>;
    }
    const view = render(<Controls open={false} />);
    for (const label of ["Go back", "Puppy"]) {
      const control = view.getByRole("button", { name: label });
      expect(control.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(control).toBeVisible();
      fireEvent.click(control);
    }
    expect(back).toHaveBeenCalledOnce(); expect(select).toHaveBeenCalledOnce();
    for (const open of [true, false, true, false]) {
      view.rerender(<Controls open={open} />);
      expect(view.getByTestId("recovery-pane").textContent).toBe("ready");
    }
    setNativeBaseAperture("recovery-probe", 1, projection.frame);
    expect(await syncNativePresentationRegions()).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(bridge.getCapabilities).not.toHaveBeenCalled();
    expect(bridge.prepare).not.toHaveBeenCalled();
    expect(bridge.setPresentationRegions).not.toHaveBeenCalled();
    expect(bridge.applyPanelPose).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("native-compositor-apertures")).toBe(false);
    expect(view.container.querySelector<HTMLElement>('[data-app-shell-root]')?.style.clipPath).toBe("");
  });
  it("keeps the React composer interactive before discovery in recovery mode, including reopen", async () => {
    vi.mocked(customNativePresentationEnabled).mockReturnValue(false);
    dockBridge.getCapabilities.mockReturnValue(new Promise(() => undefined));
    const view = render(fixture(false, vi.fn()));
    expect(view.getByTestId("dock-presentation").textContent).toBe("fallback");
    view.rerender(fixture(true, vi.fn()));
    view.rerender(fixture(false, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(view.getByTestId("dock-presentation").textContent).toBe("fallback");
    expect(dockBridge.getCapabilities).not.toHaveBeenCalled();
    expect(dockBridge.apply).not.toHaveBeenCalled();
    expect(dockBridge.subscribe).not.toHaveBeenCalled();
  });
  it.each([false, true])("waits for operation listeners before admitting the editor; rejection %s", async (reject) => {
    const input = deferred<void>();
    dockBridge.subscribe.mockImplementation(async name => { if (name === "input") await input.promise; });
    const view = render(fixture(false, vi.fn()));
    await waitFor(() => expect(dockBridge.subscribe).toHaveBeenCalledWith("input"));
    expect(dockBridge.apply).not.toHaveBeenCalled();
    expect(view.getByTestId("dock-presentation").textContent).toBe("reserved");
    await act(async () => { if (reject) input.reject(new Error("Synthetic listener refusal")); else input.resolve(); });
    if (reject) {
      await waitFor(() => expect(view.getByTestId("dock-presentation").textContent).toBe("fallback"));
      expect(dockBridge.apply).not.toHaveBeenCalled();
      expect(dockBridge.callbacks.size).toBe(0);
    } else {
      await waitFor(() => expect(dockBridge.apply).toHaveBeenCalled());
    }
  });
  it("reserves the cold dock before discovery and restores an unsupported wrapper without creating a native editor", async () => {
    const receipt = deferred<{ contractVersion: number; supported: boolean }>();
    dockBridge.getCapabilities.mockReturnValueOnce(receipt.promise);
    const view = render(fixture(false, vi.fn()));
    expect(view.getByTestId("dock-presentation").textContent).toBe("reserved");
    expect(dockBridge.apply).not.toHaveBeenCalled();
    await act(async () => receipt.resolve({ contractVersion: 1, supported: false }));
    await waitFor(() => expect(view.getByTestId("dock-presentation").textContent).toBe("fallback"));
    view.rerender(fixture(true, vi.fn()));
    expect(view.getByTestId("dock-presentation").textContent).toBe("fallback");
    expect(dockBridge.apply).not.toHaveBeenCalled();
  });
  it("keeps the reserved voice seat unpainted and inaccessible until confirmed web fallback", () => {
    function Seat({ owned }: { owned: boolean }) {
      const ports = useNativeDockPorts();
      useLayoutEffect(() => { ports?.present(owned); }, [ports, owned]);
      return <AgentBarSurface data-testid="voice-seat"><button>Talk to One</button></AgentBarSurface>;
    }
    const view = render(<AgentDockProvider><Seat owned /></AgentDockProvider>);
    expect(view.getByTestId("voice-seat").hasAttribute("inert")).toBe(true);
    expect(view.getByTestId("voice-seat").getAttribute("aria-hidden")).toBe("true");
    expect(view.getByTestId("voice-seat").classList.contains("bottom-chrome-surface")).toBe(false);
    view.rerender(<AgentDockProvider><Seat owned={false} /></AgentDockProvider>);
    expect(view.getByTestId("voice-seat").hasAttribute("inert")).toBe(false);
    expect(view.getByTestId("voice-seat").classList.contains("bottom-chrome-surface")).toBe(true);
  });
  it.each([false, true])("readmits the current dock after a newer shell layout supersedes its pending region receipt (refused %s)", async refused => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [], independentControls: true, reservedPresentationRegions: true });
    dockBridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true, reservedPresentationRegions: true });
    const receipt = deferred<NativePresentationRegions>();
    bridge.setPresentationRegions.mockReset().mockImplementation(async projection => projection)
      .mockReturnValueOnce(receipt.promise);
    const seat = document.createElement("div"); seat.dataset.appTopBar = "true";
    document.body.appendChild(seat);
    let height = 80;
    vi.spyOn(seat, "getBoundingClientRect").mockImplementation(() => ({ bottom: height } as DOMRect));
    try {
      render(fixture(false, vi.fn()));
      await waitFor(() => expect(bridge.setPresentationRegions).toHaveBeenCalledOnce());
      const obsolete = bridge.setPresentationRegions.mock.calls[0][0];
      height = 100;
      await act(async () => { expect(await syncNativePresentationRegions()).toBe(true); });
      expect(dockBridge.apply).not.toHaveBeenCalled();
      await act(async () => { if (refused) receipt.reject(new Error("NATIVE_REGIONS_STALE")); else receipt.resolve(obsolete); });
      await waitFor(() => expect(dockBridge.apply).toHaveBeenCalled());
      expect(dockBridge.retire).not.toHaveBeenCalled();
    } finally { seat.remove(); }
  });
  it("does not apply an obsolete dock snapshot after delayed region admission", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [], independentControls: true, reservedPresentationRegions: true });
    dockBridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true, reservedPresentationRegions: true });
    bridge.setPresentationRegions.mockReset().mockImplementation(async projection => projection);
    const seat = document.createElement("div"); seat.dataset.appTopBar = "true";
    document.body.appendChild(seat);
    let height = 80;
    vi.spyOn(seat, "getBoundingClientRect").mockImplementation(() => ({ bottom: height } as DOMRect));
    const view = render(fixture(false, vi.fn()));
    try {
      await waitFor(() => expect(dockBridge.apply).toHaveBeenCalled());
      const baseline = dockBridge.apply.mock.calls.length;
      bridge.setPresentationRegions.mockImplementationOnce(async projection => {
        // Change eligibility inside the bridge request, after the dock's
        // preceding privacy read has passed but before layout returns.
        act(() => view.rerender(fixture(true, vi.fn())));
        return projection;
      });
      height = 100;
      act(() => window.dispatchEvent(new Event("resize")));
      await waitFor(() => expect(bridge.setPresentationRegions.mock.calls.at(-1)![0].top).toBe(100));
      await waitFor(() => expect(dockBridge.apply.mock.calls.length).toBeGreaterThan(baseline));
      expect(dockBridge.apply.mock.calls.slice(baseline).every(([state]) => state.interactionEnabled === false)).toBe(true);
      expect(dockBridge.retire).not.toHaveBeenCalled();
      view.rerender(fixture(false, vi.fn()));
      await waitFor(() => expect(dockBridge.apply.mock.calls.at(-1)![0].interactionEnabled).toBe(true));
    } finally { seat.remove(); }
  });
  it("does not retire a newer dock lifetime when an obsolete apply fails", async () => {
    const receipt = deferred<Record<string, unknown>>();
    dockBridge.apply.mockReturnValueOnce(receipt.promise);
    const view = render(fixture(false, vi.fn()));
    await waitFor(() => expect(dockBridge.apply).toHaveBeenCalledOnce());
    view.rerender(fixture(true, vi.fn()));
    await act(async () => { receipt.reject(new Error("Synthetic delayed refusal")); });
    expect(dockBridge.retire).not.toHaveBeenCalled();
    view.rerender(fixture(false, vi.fn()));
    await waitFor(() => expect(dockBridge.apply.mock.calls.length).toBeGreaterThan(1));
    expect(dockBridge.retire).not.toHaveBeenCalled();
  });
  it("retires a consumed replica when an overlay invalidates its delayed receipt, without sending or replaying", async () => {
    const onAction = vi.fn();
    const receipt = deferred<{ consumed: boolean; editRevision: number }>();
    dockBridge.consumeDraft.mockReturnValue(receipt.promise);
    const view = render(fixture(false, onAction));
    await waitFor(() => expect(dockBridge.apply).toHaveBeenCalled());
    const initial = dockBridge.apply.mock.calls.at(-1)![0] as DockState;
    act(() => dockBridge.callbacks.get("input")?.(send(initial)));
    await waitFor(() => expect(dockBridge.consumeDraft).toHaveBeenCalledOnce());
    view.rerender(fixture(true, onAction));
    await act(async () => { receipt.resolve({ consumed: true, editRevision: 1 }); });
    await waitFor(() => expect(dockBridge.retire).toHaveBeenCalledWith(expect.objectContaining({ revision: initial.revision, preserveDraft: true })));
    expect(onAction).not.toHaveBeenCalled();
    view.rerender(fixture(false, onAction));
    await waitFor(() => expect((dockBridge.apply.mock.calls.at(-1)![0] as DockState).revision).toBeGreaterThan(initial.revision));
    expect(onAction).not.toHaveBeenCalled();
  });
  it("keeps consumption unsettled until the feature guard finishes and consumes duplicate Send only once", async () => {
    const guard = deferred<void>();
    const onAction = vi.fn(() => guard.promise);
    dockBridge.consumeDraft.mockResolvedValue({ consumed: true, editRevision: 1 });
    render(fixture(false, onAction));
    await waitFor(() => expect(dockBridge.apply).toHaveBeenCalled());
    const initial = dockBridge.apply.mock.calls.at(-1)![0] as DockState;
    const request = send(initial);
    act(() => { dockBridge.callbacks.get("input")?.(request); dockBridge.callbacks.get("input")?.(request); });
    await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
    expect(dockBridge.apply.mock.calls.every(([state]) => state.settledConsumption === 0)).toBe(true);
    await act(async () => { guard.resolve(); });
    await waitFor(() => expect(dockBridge.apply.mock.calls.some(([state]) => state.settledConsumption === 1)).toBe(true));
    expect(onAction).toHaveBeenCalledOnce();
    expect(dockBridge.consumeDraft).toHaveBeenCalledOnce();
  });
  it.each(["send", "collapse"] as const)("withdraws a delayed %s snapshot after a complete native drawer cycle without replay", async action => {
    let isolationCallback!: (event: NativeDrawerIsolation) => void;
    const handle = await subscribeNativeDrawerIsolation({
      getCapabilities: async () => ({ ...nativeDrawerIsolation() }),
      addListener: async (_, callback) => { isolationCallback = callback; return { remove: async () => undefined }; },
    });
    const operation = vi.fn();
    const receipt = deferred<{ consumed: boolean; editRevision: number; accepted: boolean }>();
    dockBridge.consumeDraft.mockReturnValue(receipt.promise);
    dockBridge.beginEditingTransition.mockReturnValue(receipt.promise);
    render(fixture(false, operation));
    await waitFor(() => expect(dockBridge.apply).toHaveBeenCalled());
    const initial = dockBridge.apply.mock.calls.at(-1)![0] as DockState;
    act(() => dockBridge.callbacks.get("input")?.({ ...send(initial), action }));
    await waitFor(() => expect(action === "send" ? dockBridge.consumeDraft : dockBridge.beginEditingTransition).toHaveBeenCalledOnce());
    const epoch = nativeDrawerIsolation().generation;
    act(() => { isolationCallback({ generation: epoch + 1, isolated: true }); isolationCallback({ generation: epoch + 2, isolated: false }); });
    await act(async () => { receipt.resolve({ consumed: true, editRevision: 1, accepted: true }); });
    await waitFor(() => expect(dockBridge.retire).toHaveBeenCalledWith(expect.objectContaining({ revision: initial.revision, preserveDraft: true })));
    expect(operation).not.toHaveBeenCalled();
    await handle.remove();
  });
});

describe("native chrome presentation lease", () => {
  it("forwards the captured panel generation and pose sequence to native confirmation", async () => {
    bridge.prepare.mockImplementation(async identity => ({ ...identity, phase: "prepared", frame: identity.frame }));
    bridge.activate.mockImplementation(async identity => ({ ...identity, phase: "active" }));
    bridge.confirmChoice.mockImplementation(async event => ({ valid: event.presentationGeneration === 7 && event.presentationSequence === 12 }));
    const lease = new NativeChromeLease({ ...projection, presentationGroup: "profile", presentationOwnerEpoch: "group-epoch", presentationGeneration: 7 }, "owner-a");
    await lease.prepare(); await lease.activate();
    const action = vi.fn();
    await lease.choose({ ...choice(lease), presentationGeneration: 7, presentationSequence: 12 }, () => true, action);
    expect(action).toHaveBeenCalledOnce();
    await lease.choose({ ...choice(lease, 2), presentationGeneration: 7, presentationSequence: 11 }, () => true, action);
    expect(action).toHaveBeenCalledOnce();
  });
  beforeEach(async () => {
    vi.mocked(customNativePresentationEnabled).mockReturnValue(true);
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.style.removeProperty("--app-accent");
    document.documentElement.style.removeProperty("--app-accent-deep");
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    document.documentElement.style.removeProperty("--background");
    bridge.platform = "ios";
    profile.query = "profile_pane=1"; profile.unlocked = true; profile.pathname = "/";
    voiceSurface.current = null;
    bridge.documentId = crypto.randomUUID();
    bridge.callbacks.clear();
    bridge.listeners.clear();
    bridge.subscribe.mockReset().mockResolvedValue(undefined);
    bridge.getCapabilities.mockReset().mockResolvedValue({ contractVersion: 2, families: ["back"], independentControls: true });
    bridge.setCanvasAppearance.mockReset().mockImplementation(async (value) => value);
    bridge.setPresentationRegions.mockReset().mockImplementation(async (value) => value);
    bridge.applyPanelPose.mockReset().mockImplementation(async (value) => value);
    bridge.retirePanel.mockReset().mockImplementation(async (value) => value);
    bridge.prepare.mockReset().mockImplementation(async (value: ChromeProjection) => ({ ...value, phase: "prepared" }));
    bridge.prepareBackReplacement.mockReset().mockImplementation(async (value: ChromeProjection) => ({ ...value, phase: "prepared" }));
    bridge.prepareHistoryReplacement.mockReset().mockImplementation(async (value: ChromeProjection) => ({ ...value, phase: "prepared" }));
    bridge.activate.mockReset().mockImplementation(async (value) => ({ ...value, phase: "active" }));
    bridge.update.mockReset().mockImplementation(async (value) => value);
    bridge.restoreFocus.mockReset().mockImplementation(async (value) => ({ ...value, restored: true }));
    bridge.retire.mockReset().mockImplementation(async (value) => ({ ...value, phase: "retired" }));
    bridge.suspend.mockReset().mockImplementation(async (value) => ({ ...value, phase: "suspended" }));
    bridge.confirmChoice.mockReset().mockResolvedValue({ valid: true });
    await Promise.all(["top-shell-back", "profile-back", "chat-history-toggle", "chat-agent-surface", "profile-close", "stationary-more", "bounded-selection", "bounded-date", "profile-appearance", "profile-accent"].map((controlId) =>
      retireNativeChrome("owner-a", undefined, controlId as ChromeProjection["controlId"])));
  });
  afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve(); }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("stops pose delivery on teardown but retires only after the matching uncovered receipt", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"],
      independentControls: true, reservedPresentationRegions: true, fullWindowOverlays: true, drawerClipping: true });
    function Panel() {
      const ref = useRef<HTMLDivElement>(null);
      const attach = useNativePanelPresentation("profile", "synthetic-owner", ref, true);
      useLayoutEffect(() => { if (ref.current) ref.current.getAnimations = () => []; }, []);
      return <div ref={attach} data-native-panel-group="profile" />;
    }
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 150, y: 0, width: 390, height: window.innerHeight, bottom: window.innerHeight } as DOMRect);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    await getNativeChromeCapabilities();
    setNativePresentationRegionIsolation(true, true, "profile");
    expect(await syncNativePresentationRegions()).toBe(true);
    const view = render(<Panel />);
    await waitFor(() => expect(bridge.applyPanelPose).toHaveBeenCalled());
    const captured = bridge.applyPanelPose.mock.calls.at(-1)![0] as NativePanelPose;
    const poseCount = bridge.applyPanelPose.mock.calls.length;
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(bridge.retirePanel).not.toHaveBeenCalled();
    const delayed = deferred<NativePresentationRegions>();
    bridge.setPresentationRegions.mockReturnValueOnce(delayed.promise);
    setNativePresentationRegionIsolation(false);
    await waitFor(() => expect(bridge.setPresentationRegions.mock.calls.at(-1)?.[0].covered).toBe(false));
    expect(bridge.retirePanel).not.toHaveBeenCalled();
    expect(bridge.applyPanelPose).toHaveBeenCalledTimes(poseCount);
    const release = bridge.setPresentationRegions.mock.calls.at(-1)![0];
    await act(async () => { delayed.resolve(release); });
    await waitFor(() => expect(bridge.retirePanel).toHaveBeenCalledOnce());
    expect(bridge.retirePanel).toHaveBeenCalledWith(expect.objectContaining({
      documentId: captured.documentId, ownerEpoch: captured.ownerEpoch, generation: captured.generation }));
  });
  it("does not mistake a superseded release or reopening for uncovered admission", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"],
      independentControls: true, reservedPresentationRegions: true, fullWindowOverlays: true, drawerClipping: true });
    await getNativeChromeCapabilities();
    setNativePresentationRegionIsolation(true, true, "profile");
    expect(await syncNativePresentationRegions()).toBe(true);
    const retired = vi.fn();
    const waiting = waitForNativeDrawerCoverageRelease(bridge.documentId, 0).then(retired);
    const delayed = deferred<NativePresentationRegions>();
    bridge.setPresentationRegions.mockReturnValueOnce(delayed.promise);
    setNativePresentationRegionIsolation(false);
    await waitFor(() => expect(bridge.setPresentationRegions.mock.calls.at(-1)?.[0].covered).toBe(false));
    const obsolete = bridge.setPresentationRegions.mock.calls.at(-1)![0];
    setNativePresentationRegionIsolation(true, true, "profile");
    expect(await syncNativePresentationRegions()).toBe(true);
    await act(async () => { delayed.resolve(obsolete); });
    expect(retired).not.toHaveBeenCalled();
    setNativePresentationRegionIsolation(false);
    expect(await syncNativePresentationRegions()).toBe(true);
    await waiting;
    expect(retired).toHaveBeenCalledExactlyOnceWith("released");
  });
  it.each([false, true])("admits coverage and its authored initial pose together; superseded owner %s", async superseded => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [], independentControls: true,
      reservedPresentationRegions: true, fullWindowOverlays: true, drawerClipping: true, atomicDrawerCoverage: true });
    await getNativeChromeCapabilities();
    setNativePresentationRegionIsolation(false);
    await syncNativePresentationRegions();
    const identity = { documentId: bridge.documentId, ownerEpoch: "synthetic-drawer", group: "profile" as const, generation: 10 };
    const remove = registerNativeDrawerPose(identity, privacyGeneration => ({ ...identity, sequence: 1, privacyGeneration,
      frame: { x: 0, y: 0, width: 390, height: 844 }, offset: 200, opacity: 1, settled: false }));
    const delayed = deferred<NativePresentationRegions>();
    bridge.setPresentationRegions.mockReturnValueOnce(delayed.promise);
    try {
      setNativePresentationRegionIsolation(true, true, "profile");
      await waitFor(() => expect(bridge.setPresentationRegions.mock.calls.at(-1)![0].initialDrawerPose).toBeDefined());
      const projection = bridge.setPresentationRegions.mock.calls.at(-1)![0];
      expect(projection.initialDrawerPose).toEqual(expect.objectContaining({ ...identity, sequence: 1, offset: 200, opacity: 1 }));
      const waiting = syncNativePresentationRegions();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      if (superseded) remove();
      await act(async () => { delayed.resolve(projection); });
      expect(await waiting).toBe(!superseded);
      expect(nativePresentationAdmission().presentationRegionRevision === projection.revision).toBe(!superseded);
    } finally { remove(); setNativePresentationRegionIsolation(false); await syncNativePresentationRegions(); }
  });
  it.each(["privacy", "timeout"])("ends normal-retirement waiting fail-closed on %s", async reason => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"],
      independentControls: true, reservedPresentationRegions: true, fullWindowOverlays: true, drawerClipping: true });
    await getNativeChromeCapabilities();
    setNativePresentationRegionIsolation(true, true, "profile");
    expect(await syncNativePresentationRegions()).toBe(true);
    const callbacks = privacy.callbacks.size;
    if (reason === "timeout") vi.useFakeTimers();
    try {
      const waiting = waitForNativeDrawerCoverageRelease(bridge.documentId, 0);
      await act(async () => { await Promise.resolve(); });
      if (reason === "privacy") privacy.callbacks.forEach(callback => callback({ generation: 1, shielded: true, appIsActive: false }));
      else await vi.advanceTimersByTimeAsync(3001);
      expect(await waiting).toBe(reason === "privacy" ? "invalidated" : "uncertain");
      expect(privacy.callbacks.size).toBe(callbacks);
    } finally { vi.useRealTimers(); setNativePresentationRegionIsolation(false); await syncNativePresentationRegions(); }
  });
  it("admits full-height panes only after current coverage and rejects an open-close-reopen receipt", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history", "agent-surface"],
      independentControls: true, reservedPresentationRegions: true, fullWindowOverlays: true, drawerClipping: true });
    const seat = document.createElement("div"); seat.dataset.appTopBar = "true";
    document.body.appendChild(seat);
    vi.spyOn(seat, "getBoundingClientRect").mockReturnValue({ bottom: 100 } as DOMRect);
    function Cover({ active }: { active: boolean }) {
      useNativeNavigationBlocked(active, "profile-pane");
      const ready = useNativeFullWindowOverlayReady(active);
      return <span data-testid="cover-state">{!active ? "closed" : ready ? "admitted" : "waiting"}</span>;
    }
    try {
      expect(await syncNativePresentationRegions()).toBe(true);
      const delayed = deferred<NativePresentationRegions>();
      bridge.setPresentationRegions.mockReturnValueOnce(delayed.promise);
      const view = render(<Cover active />);
      await waitFor(() => expect(bridge.setPresentationRegions).toHaveBeenCalledTimes(2));
      const obsolete = bridge.setPresentationRegions.mock.calls[1][0];
      expect(view.getByTestId("cover-state").textContent).toBe("waiting");
      expect(obsolete).toEqual(expect.objectContaining({ covered: true, isolated: true, privacyGeneration: 0, top: 100, drawer: "profile" }));
      view.rerender(<Cover active={false} />);
      await waitFor(() => expect(bridge.setPresentationRegions).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(nativePresentationAdmission().presentationRegionRevision).toBeGreaterThan(obsolete.revision));
      await waitFor(() => expect(document.documentElement.hasAttribute("data-native-full-window-covered")).toBe(false));
      view.rerender(<Cover active />);
      await waitFor(() => expect(view.getByTestId("cover-state").textContent).toBe("admitted"));
      const admission = nativePresentationAdmission();
      await act(async () => { delayed.resolve(obsolete); });
      expect(nativePresentationAdmission()).toEqual(admission);
      expect(admission.presentationRegionRevision).toBeGreaterThan(obsolete.revision);
      expect(document.documentElement.style.getPropertyValue("--native-overlay-top")).toBe("0px");
      expect(document.documentElement.hasAttribute("data-native-full-window-covered")).toBe(true);
    } finally { seat.remove(); }
  });
  it.each([false, true])("rejects stale region acknowledgments even when returning to the previously accepted layout (refused %s)", async refused => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back"], independentControls: true, reservedPresentationRegions: true });
    const seat = document.createElement("div"); seat.dataset.appTopBar = "true";
    document.body.appendChild(seat);
    let height = 80;
    vi.spyOn(seat, "getBoundingClientRect").mockImplementation(() => ({ bottom: height } as DOMRect));
    try {
      expect(await syncNativePresentationRegions()).toBe(true);
      const delayed = deferred<NativePresentationRegions>();
      bridge.setPresentationRegions.mockReturnValueOnce(delayed.promise);
      height = 100;
      const changing = syncNativePresentationRegions();
      await waitFor(() => expect(bridge.setPresentationRegions).toHaveBeenCalledTimes(2));
      const obsolete = bridge.setPresentationRegions.mock.calls[1][0];
      height = 80;
      expect(await syncNativePresentationRegions()).toBe(true);
      if (refused) delayed.reject(new Error("NATIVE_REGIONS_STALE")); else delayed.resolve(obsolete);
      expect(await changing).toBe(false);
      expect(document.documentElement.style.getPropertyValue("--native-overlay-top")).toBe("80px");
      // Supersession is not permission to swallow a current native failure.
      height = 120;
      bridge.setPresentationRegions.mockRejectedValueOnce(new Error("NATIVE_REGIONS_STALE"));
      await expect(syncNativePresentationRegions()).rejects.toThrow("NATIVE_REGIONS_STALE");
    } finally { seat.remove(); }
  });
  it("retains preparation after superseded admission without authorizing or replaying a choice", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    await lease.prepare();
    const retireCount = bridge.retire.mock.calls.length;
    bridge.activate.mockResolvedValueOnce({ ...lease.projection, phase: "active", presentationApplied: false });
    await lease.activate();
    expect(lease.admissionReady).toBe(false);
    expect(lease.ownsInstallation).toBe(true);
    const action = vi.fn();
    await lease.choose(choice(lease), () => true, action);
    expect(action).not.toHaveBeenCalled();
    expect(bridge.retire).toHaveBeenCalledTimes(retireCount);
    await lease.activate();
    expect(lease.admissionReady).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });
  it.each([false, true])("reconciles superseded shell preparation without reviving a cancelled lease (%s)", async cancelled => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back"], independentControls: true, reservedPresentationRegions: true });
    await getNativeChromeCapabilities();
    const receipt = deferred<NativePresentationRegions>();
    bridge.setPresentationRegions.mockReturnValueOnce(receipt.promise);
    const seat = document.createElement("div"); seat.dataset.appTopBar = "true";
    document.body.appendChild(seat);
    let height = 120;
    vi.spyOn(seat, "getBoundingClientRect").mockImplementation(() => ({ bottom: height } as DOMRect));
    try {
      const lease = new NativeChromeLease(projection, "owner-a");
      const preparing = lease.prepare();
      await waitFor(() => expect(bridge.setPresentationRegions).toHaveBeenCalledOnce());
      const obsolete = bridge.setPresentationRegions.mock.calls[0][0];
      height = 140;
      expect(await syncNativePresentationRegions()).toBe(true);
      if (cancelled) lease.invalidate();
      receipt.resolve(obsolete);
      expect(await preparing).toBe(!cancelled);
      expect(bridge.prepare).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    } finally { seat.remove(); }
  });

  it("requires acknowledged suspension and identical ownership/schema/geometry before resuming a host with fresh authority", async () => {
    const epoch = chromeOwnerEpoch("account-a", "top-shell-back");
    expect(chromeOwnerEpoch("account-a", "top-shell-back")).toBe(epoch);
    const old = new NativeChromeLease(projection, epoch);
    await old.prepare(); await old.activate();
    const receipt = deferred<ChromeAcknowledgement>();
    bridge.suspend.mockReturnValueOnce(receipt.promise);
    const suspension = suspendOwnedNativeChrome(old);
    const resume = canResumeNativeChrome(projection, epoch);
    const invoke = vi.fn();
    await old.choose(choice(old), () => true, invoke);
    expect(invoke).not.toHaveBeenCalled();
    receipt.resolve({ ...old.projection, phase: "suspended" });
    await suspension;
    expect(await resume).toBe(true);
    expect(await canResumeNativeChrome({ ...projection, frame: { ...projection.frame, x: 3 } }, epoch)).toBe(false);
    expect(await canResumeNativeChrome({ ...projection, label: "Another action" }, epoch)).toBe(false);
    expect(await canResumeNativeChrome(projection, chromeOwnerEpoch("account-b", "top-shell-back"))).toBe(false);
    const next = new NativeChromeLease(projection, epoch);
    await next.prepare(); await next.activate();
    await retireOwnedNativeChrome(old.projection);
    expect(next.ownsInstallation).toBe(true);
    await next.choose(choice(old), () => true, invoke);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("does not resume an uncertain suspension or release its concealed slot before retirement", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    await lease.prepare(); await lease.activate();
    bridge.suspend.mockResolvedValueOnce({ ...lease.projection, phase: "retired" });
    await expect(suspendOwnedNativeChrome(lease)).rejects.toThrow("NATIVE_CHROME_SUSPEND_UNCONFIRMED");
    expect(await canResumeNativeChrome(projection, "owner-a")).toBe(false);
    expect(hasOutstandingNativeChrome()).toBe(true);
    await retireOwnedNativeChrome(lease.projection);
    expect(hasOutstandingNativeChrome()).toBe(false);
  });
  it("discovers immutable wrapper capabilities once per document, not per control or route", async () => {
    const capability = deferred<{ contractVersion: number; families: "back"[]; independentControls: boolean }>();
    bridge.getCapabilities.mockReturnValueOnce(capability.promise);
    const first = getNativeChromeCapabilities(), second = getNativeChromeCapabilities();
    expect(bridge.getCapabilities).toHaveBeenCalledOnce();
    capability.resolve({ contractVersion: 2, families: ["back"], independentControls: true });
    expect(await first).toBe(await second);
    expect(await getNativeChromeCapabilities()).toBe(peekNativeChromeCapabilities());
    expect(bridge.getCapabilities).toHaveBeenCalledOnce();
    bridge.documentId = crypto.randomUUID();
    expect(peekNativeChromeCapabilities()).toBeUndefined();
    await getNativeChromeCapabilities();
    expect(bridge.getCapabilities).toHaveBeenCalledTimes(2);
    bridge.platform = "android";
    expect(await getNativeChromeCapabilities()).toBeNull();
    expect(peekNativeChromeCapabilities()).toBeUndefined();
  });
  it("uses the committed CSS canvas and cannot repaint an older theme after delayed discovery", async () => {
    const discovery = deferred<{ contractVersion: number; families: "back"[]; canvasAppearance: boolean }>();
    const capability = { contractVersion: 2, families: [] as "back"[], canvasAppearance: true };
    document.documentElement.style.setProperty("--background", "#f2f2f7");
    bridge.getCapabilities.mockReturnValueOnce(discovery.promise).mockResolvedValue(capability);
    const old = syncNativeCanvasAppearance();
    document.documentElement.style.setProperty("--background", "#0e0e10");
    const latest = syncNativeCanvasAppearance();
    discovery.resolve(capability);
    expect(await latest).toBe(true);
    expect(await old).toBe(false);
    expect(bridge.setCanvasAppearance).toHaveBeenCalledOnce();
    expect(bridge.setCanvasAppearance.mock.calls[0][0]).toMatchObject({ documentId: bridge.documentId, backgroundHex: "#0e0e10" });
    bridge.documentId = crypto.randomUUID();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [] });
    expect(await syncNativeCanvasAppearance()).toBe(false);
    bridge.documentId = crypto.randomUUID();
    bridge.getCapabilities.mockResolvedValue(capability);
    bridge.setCanvasAppearance.mockImplementation(async (value) => ({ ...value, revision: value.revision - 1 }));
    await expect(syncNativeCanvasAppearance()).rejects.toThrow("NATIVE_CANVAS_ACK_UNCONFIRMED");
  });
  it("does not transfer interaction before matching layout and activation acknowledgements", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    const action = vi.fn();
    await lease.prepare();
    await lease.choose(choice(lease), () => true, action);
    expect(action).not.toHaveBeenCalled();
    await lease.activate();
    await lease.choose(choice(lease), () => true, action);
    expect(action).toHaveBeenCalledOnce();
    await lease.choose(choice(lease), () => true, action);
    expect(action).toHaveBeenCalledOnce();
  });
  it("projects committed foreground traits with the canvas and never cuts an aperture for page-backed glass", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back"], independentControls: true,
      contentBackedPresentation: true, canvasAppearance: true, panelPresentation: true });
    const shell = document.createElement("main");
    shell.dataset.appShellRoot = "true";
    document.body.appendChild(shell);
    document.documentElement.style.setProperty("--background", "#f2f2f7");
    document.documentElement.classList.remove("dark");
    const lease = new NativeChromeLease(projection, "owner-a");
    try {
      expect(await syncNativeCanvasAppearance()).toBe(true);
      expect(bridge.setCanvasAppearance.mock.calls.at(-1)![0]).toMatchObject({ appearance: "light", backgroundHex: "#f2f2f7" });
      document.documentElement.classList.add("dark");
      document.documentElement.style.setProperty("--background", "#0e0e10");
      expect(await syncNativeCanvasAppearance()).toBe(true);
      expect(bridge.setCanvasAppearance.mock.calls.at(-1)![0]).toMatchObject({ appearance: "dark", backgroundHex: "#0e0e10" });
      await lease.prepare(); await lease.activate();
      expect(shell.style.clipPath).toBe("");
      expect(document.documentElement.classList.contains("native-compositor-apertures")).toBe(false);
    } finally {
      lease.invalidate(); await retireOwnedNativeChrome(lease.projection); shell.remove();
      document.documentElement.classList.remove("dark");
      document.documentElement.style.removeProperty("--background");
    }
  });
  it("fences choices across reordered in-place snapshots without replacing the lease", async () => {
    const lease = new NativeChromeLease(projection, "owner-a", "context", true);
    await lease.prepare(); await lease.activate();
    const first = deferred<ChromeUpdateAcknowledgement>();
    const second = deferred<ChromeUpdateAcknowledgement>();
    bridge.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const action = vi.fn();
    const older = lease.update({ ...projection, accentHex: "#334455", enabled: true });
    await waitFor(() => expect(bridge.update).toHaveBeenCalledOnce());
    const newer = lease.update({ ...projection, accentHex: "#556677", enabled: true });
    await waitFor(() => expect(bridge.update).toHaveBeenCalledTimes(2));
    expect(await lease.choose({ ...choice(lease), updateSequence: 0 }, () => true, action)).toBe("update-pending");
    expect(action).not.toHaveBeenCalled();
    second.resolve(bridge.update.mock.calls[1][0]); expect(await newer).toBe(true);
    first.resolve(bridge.update.mock.calls[0][0]); expect(await older).toBe(false);
    expect(lease.projection.accentHex).toBe("#556677");
    expect(await lease.choose({ ...choice(lease), updateSequence: 1 }, () => true, action)).toBe("update-pending");
    expect(action).not.toHaveBeenCalled();
    expect(await lease.choose({ ...choice(lease), updateSequence: 2 }, () => true, action)).toBe("applied");
    expect(action).toHaveBeenCalledOnce();
    await lease.update({ ...projection, enabled: false });
    await lease.choose({ ...choice(lease, 2), updateSequence: 3 }, () => true, action);
    expect(action).toHaveBeenCalledOnce();
    expect(bridge.prepare).toHaveBeenCalledOnce();
    expect(bridge.activate).toHaveBeenCalledOnce();
  });
  it("does not fence an identical acknowledged presentation but never coalesces across a pending change", async () => {
    const lease = new NativeChromeLease(projection, "owner-a", "context", true);
    await lease.prepare();
    const activation = deferred<ChromeAcknowledgement>();
    bridge.activate.mockReturnValueOnce(activation.promise);
    const original = { appearance: projection.appearance, accentHex: projection.accentHex,
      foregroundHex: projection.foregroundHex, enabled: true };
    const activating = lease.activate();
    const unchangedDuringActivation = lease.update(original);
    const action = vi.fn();
    await lease.choose({ ...choice(lease), updateSequence: 0 }, () => true, action);
    expect(action).not.toHaveBeenCalled();
    activation.resolve({ ...lease.projection, phase: "active" });
    await activating;
    expect(await unchangedDuringActivation).toBe(true);
    expect(bridge.update).not.toHaveBeenCalled();
    await lease.choose({ ...choice(lease), updateSequence: 0 }, () => true, action);
    expect(action).toHaveBeenCalledOnce();
    const pending = deferred<ChromeUpdateAcknowledgement>();
    bridge.update.mockReturnValueOnce(pending.promise);
    const changing = lease.update({ ...original, accentHex: "#334455" });
    await waitFor(() => expect(bridge.update).toHaveBeenCalledOnce());
    const reverting = lease.update(original);
    await waitFor(() => expect(bridge.update).toHaveBeenCalledTimes(2));
    expect(await reverting).toBe(true);
    pending.resolve(bridge.update.mock.calls[0][0]);
    expect(await changing).toBe(false);
    expect(lease.projection.accentHex).toBe(original.accentHex);
    expect(await lease.update(original)).toBe(true);
    expect(bridge.update).toHaveBeenCalledTimes(2);
    // An uncover receipt must refresh the current permissions even when the
    // projection itself is unchanged. It must not recreate a host or lease.
    expect(await lease.update(original, true)).toBe(true);
    expect(bridge.update).toHaveBeenCalledTimes(3);
    expect(bridge.prepare).toHaveBeenCalledOnce();
    expect(bridge.activate).toHaveBeenCalledOnce();
    lease.invalidate();
    expect(await lease.update(original)).toBe(false);
    const obsolete = new NativeChromeLease(projection, "owner-a", "old-context", true);
    await obsolete.prepare();
    const delayedActivation = deferred<ChromeAcknowledgement>();
    bridge.activate.mockReturnValueOnce(delayedActivation.promise);
    const readmission = obsolete.update(original, true);
    const observed = readmission.then(result => ({ result }));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    obsolete.invalidate();
    delayedActivation.reject(new Error("Synthetic departed-owner activation failure"));
    expect(await observed).toEqual({ result: false });
  });
  it("keeps an uncertain presentation quarantined until exact retirement is confirmed", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    bridge.prepare.mockImplementation(async (value) => ({ ...value, frame: { ...projection.frame, x: 99 }, phase: "prepared" }));
    await expect(lease.prepare()).rejects.toThrow("LAYOUT_UNCONFIRMED");
    expect(hasOutstandingNativeChrome()).toBe(true);
    bridge.retire.mockImplementation(async (value) => ({ ...value, revision: value.revision - 1, phase: "retired" }));
    await expect(retireNativeChrome("owner-a")).rejects.toThrow("RETIRE_UNCONFIRMED");
    expect(hasOutstandingNativeChrome()).toBe(true);
    bridge.retire.mockImplementation(async (value) => ({ ...value, phase: "retired" }));
    await retireNativeChrome("owner-a");
    expect(hasOutstandingNativeChrome()).toBe(false);
  });
  it.each(["owner", "context", "privacy", "disabled"])("rejects %s changes while a choice is being confirmed", async (reason) => {
    const lease = new NativeChromeLease({ ...projection, enabled: reason !== "disabled" }, "owner-a");
    const pending = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValue(pending.promise);
    const action = vi.fn();
    let allowed = true;
    await lease.prepare(); await lease.activate();
    const result = lease.choose(choice(lease), () => allowed, action);
    if (reason === "owner") lease.invalidate(); else allowed = false;
    pending.resolve({ valid: true }); await result;
    expect(action).not.toHaveBeenCalled();
  });
  it("does not activate a retired preparation or accept another owner/revision", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    const pending = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValue(pending.promise);
    const preparing = lease.prepare(); lease.invalidate();
    pending.resolve({ ...lease.projection, phase: "prepared" });
    expect(await preparing).toBe(false);
    await lease.activate(); expect(bridge.activate).not.toHaveBeenCalled();
    const fresh = new NativeChromeLease(projection, "owner-b");
    bridge.prepare.mockImplementation(async (value) => ({ ...value, phase: "prepared" }));
    await fresh.prepare(); await fresh.activate();
    const action = vi.fn();
    await fresh.choose(choice(lease), () => true, action);
    expect(action).not.toHaveBeenCalled();
  });
  it("never lets late recovery retire a replacement or reordered confirmations execute twice", async () => {
    const old = new NativeChromeLease(projection, "owner-a");
    await old.prepare(); await old.activate();
    const fresh = new NativeChromeLease(projection, "owner-b");
    await fresh.prepare(); await fresh.activate();
    bridge.retire.mockClear();
    await retireNativeChrome("owner-a", old.projection);
    expect(bridge.retire).not.toHaveBeenCalled();
    const first = deferred<{ valid: boolean }>();
    const second = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const action = vi.fn();
    const firstChoice = fresh.choose(choice(fresh, 1), () => true, action);
    const secondChoice = fresh.choose(choice(fresh, 2), () => true, action);
    second.resolve({ valid: true }); await secondChoice;
    first.resolve({ valid: true }); await firstChoice;
    expect(action).toHaveBeenCalledOnce();
    await fresh.choose(choice(fresh, 3), () => true, action);
    // A new intentional tap remains available if navigation was cancelled.
    // It is not a replay of either previously consumed choice.
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("retires only the requested independent control, including delayed acknowledgement", async () => {
    const back = new NativeChromeLease(projection, "owner-a");
    const history = new NativeChromeLease({ ...projection, kind: "history", label: "Open chat history" }, "owner-a");
    const selector = new NativeChromeLease({ ...projection, kind: "agent-surface", value: "one",
      frame: { ...projection.frame, x: 100, width: 100 } }, "owner-a");
    for (const lease of [back, history, selector]) { await lease.prepare(); await lease.activate(); }
    expect([back, history, selector].map((lease) => hasOutstandingNativeChrome(lease.projection.controlId))).toEqual([true, true, true]);
    const retired = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(retired.promise);
    history.invalidate();
    const retirement = retireNativeChrome("owner-a", history.projection);
    const request = bridge.retire.mock.calls.at(-1)![0];
    const replacement = new NativeChromeLease({ ...projection, kind: "history" }, "owner-b");
    await replacement.prepare(); await replacement.activate();
    retired.resolve({ ...request, phase: "retired" }); await retirement;
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(true);
    bridge.retire.mockClear();
    await retireNativeChrome("owner-a", history.projection);
    await retireNativeChrome("owner-a", back.projection, "chat-agent-surface");
    expect(bridge.retire).not.toHaveBeenCalled();
    const actions = [vi.fn(), vi.fn(), vi.fn()];
    await back.choose(choice(back), () => true, actions[0]);
    await selector.choose({ ...choice(selector), value: "puppy" }, () => true, actions[1]);
    await replacement.choose(choice(replacement), () => true, actions[2]);
    actions.forEach((action) => expect(action).toHaveBeenCalledOnce());
    await retireNativeChrome("owner-b", replacement.projection);
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false);
    expect(hasOutstandingNativeChrome()).toBe(true);
    expect(hasOutstandingNativeChrome("chat-agent-surface")).toBe(true);
  });

  it("rejects stale selector identities and unbounded values before native confirmation", async () => {
    const selector = new NativeChromeLease({ ...projection, kind: "agent-surface", value: "one",
      frame: { ...projection.frame, width: 100 } }, "owner-a");
    await selector.prepare(); await selector.activate();
    const action = vi.fn();
    const event = { ...choice(selector), value: "puppy" as const };
    for (const invalid of [
      { ...event, ownerEpoch: "other-owner" }, { ...event, revision: event.revision - 1 },
      { ...event, controlId: "chat-history-toggle" as const }, { ...event, documentId: "other-document" },
      { ...event, value: "unbounded" as "one" }, { ...event, value: undefined },
    ]) await selector.choose(invalid, () => true, action);
    expect(bridge.confirmChoice).not.toHaveBeenCalled();
    await selector.choose(event, () => true, action);
    expect(bridge.confirmChoice).toHaveBeenCalledWith(expect.objectContaining({ controlId: "chat-agent-surface", value: "puppy" }));
    expect(action).toHaveBeenCalledOnce();
  });

  function ChatHarness({ kind = "history", value = "one", pendingAttention = 0, owner = "synthetic-owner",
    context = "/one/chat:vault-epoch", onAction = vi.fn(), handle, suppressed = false, eligible = true }: {
    kind?: "history" | "agent-surface"; value?: "one" | "puppy"; pendingAttention?: number;
    owner?: string; context?: string; onAction?: (value?: "one" | "puppy") => void;
    handle?: ReturnType<typeof createRef<NativeChatChromeHandle>>;
    suppressed?: boolean; eligible?: boolean;
  }) {
    useSessionChromeSuppression(suppressed);
    const focusRef = useRef<HTMLButtonElement>(null);
    const common = { owner, context, eligible, className: "chat-slot", focusRef, ref: handle };
    const fallback = <button ref={focusRef}>Authored {kind}</button>;
    return kind === "history"
      ? <NativeChatChrome {...common} kind="history" pendingAttention={pendingAttention} onActivate={onAction}>{fallback}</NativeChatChrome>
      : <NativeChatChrome {...common} kind="agent-surface" value={value} onValueChange={onAction}>{fallback}</NativeChatChrome>;
  }
  function admitChat() {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back", "history", "agent-surface"], independentControls: true });
  }
  it.each([true, false])("does not paint a cold web control before native capability discovery (supported=%s)", async (supported) => {
    measureSlot();
    const receipt = deferred<{ contractVersion: number; families: readonly string[]; independentControls: boolean }>();
    bridge.getCapabilities.mockReturnValueOnce(receipt.promise);
    const view = render(<ChatHarness />);
    expect(view.getByText("Authored history")).not.toBeVisible();
    expect(bridge.activate).not.toHaveBeenCalled();
    await act(async () => receipt.resolve({ contractVersion: 2, families: supported ? ["history"] : [], independentControls: true }));
    if (supported) {
      await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
      expect(view.getByText("Authored history")).not.toBeVisible();
    } else {
      await waitFor(() => expect(view.getByText("Authored history")).toBeVisible());
      expect(bridge.prepare).not.toHaveBeenCalled();
    }
  });
  it("does not flash its web replacement between native retirement and the next preparation", async () => {
    admitChat();
    await getNativeChromeCapabilities(); // App-wide bootstrap, before this route mounts.
    let x = 2;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x, y: 60, width: 44, height: 44, top: 60, left: x, right: x + 44, bottom: 104, toJSON: () => ({}),
    }));
    const preparing = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValue(preparing.promise);
    const view = render(<ChatHarness />);
    const fallback = view.getByText("Authored history");
    expect(fallback).not.toBeVisible();
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledOnce());
    expect(fallback).not.toBeVisible();
    await act(async () => preparing.resolve({ ...bridge.prepare.mock.calls[0][0], phase: "prepared" }));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const replacement = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValue(replacement.promise);
    const retirement = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(retirement.promise);
    const removals = bridge.retire.mock.calls.length;
    act(() => bridge.callbacks.get("invalidated")?.(undefined));
    await waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(removals + 1));
    expect(fallback).not.toBeVisible();
    x = 3; // DOM-only movement during retirement, without a resize notification.
    await act(async () => retirement.resolve({ ...bridge.retire.mock.calls.at(-1)![0], phase: "retired" }));
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledTimes(2));
    expect(bridge.prepare.mock.calls[1][0].frame.x).toBe(3);
    expect(fallback).not.toBeVisible();
    await act(async () => replacement.reject(new Error("NATIVE_CHROME_PREPARE_REFUSED")));
    await waitFor(() => expect(fallback).toBeVisible()); // Only confirmed failure retirement restores it.
    expect(bridge.getCapabilities).toHaveBeenCalledOnce();
  });
  it("readmits a privacy-retired header after release without replaying its old choice", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"], independentControls: true,
      coherentPresentation: true, retainedControls: true, inPlaceUpdates: true });
    bridge.prepare.mockImplementation(async state => {
      if (privacy.state.shielded) throw new Error("NATIVE_PRIVACY_COVERED");
      return { ...state, phase: "prepared" };
    });
    const action = vi.fn();
    const view = render(<ChatHarness onAction={action} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const old = bridge.prepare.mock.calls.at(-1)![0];
    act(() => {
      privacy.state = { ...privacy.state, generation: 1, shielded: true };
      bridge.callbacks.get("invalidated")?.(undefined);
      privacy.callbacks.forEach(callback => callback(privacy.state));
    });
    await waitFor(() => expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false));
    const coveredPreparations = bridge.prepare.mock.calls.length;
    act(() => {
      privacy.state = { ...privacy.state, shielded: false };
      privacy.callbacks.forEach(callback => callback(privacy.state));
    });
    await waitFor(() => expect(bridge.prepare.mock.calls.length).toBeGreaterThan(coveredPreparations));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    expect(view.getByText("Authored history")).not.toBeVisible();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, privacyGeneration: 0, updateSequence: 0 }));
    expect(action).not.toHaveBeenCalled();
  });
  it.each(["back", "history"] as const)("recovers a warm concealed %s slot after listener setup fails", async (kind) => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [kind], independentControls: true });
    await getNativeChromeCapabilities();
    bridge.subscribe.mockRejectedValueOnce(new Error("synthetic-subscription-failure"));
    const view = render(kind === "back" ? <Harness /> : <ChatHarness />);
    const fallback = kind === "back" ? view.getByLabelText("Go back") : view.getByText("Authored history");
    expect(fallback).not.toBeVisible();
    await waitFor(() => expect(fallback).toBeVisible());
    expect(bridge.prepare).not.toHaveBeenCalled();
    await waitFor(() => expect([...bridge.listeners.values()].reduce((total, listeners) => total + listeners.size, 0)).toBe(0));
    view.unmount();

    // A failed channel is not authority over a different mounted control.
    measureSlot();
    const subscription = deferred<void>();
    bridge.subscribe.mockReturnValueOnce(subscription.promise);
    const subscriptions = bridge.subscribe.mock.calls.length;
    const oldAction = vi.fn(), currentAction = vi.fn();
    const pending = render(retainedControl(kind, "pending-listener", oldAction));
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalledTimes(subscriptions + 3));
    const currentView = render(retainedControl(kind, "current-listener", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const currentControl = bridge.prepare.mock.calls.at(-1)![0];
    const removals = bridge.retire.mock.calls.length;
    await act(async () => subscription.reject(new Error("synthetic-subscription-failure")));
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    expect(within(pending.container).getByRole("button", { hidden: true })).not.toBeVisible();
    expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(true);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...currentControl, sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledOnce());
    expect(oldAction).not.toHaveBeenCalled();
    pending.unmount();
    currentView.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(false));
  });
  function PreferenceHarness({ eligible = true, onAppearance = vi.fn(), onAccent = vi.fn() }: {
    eligible?: boolean; onAppearance?: (value: "light" | "dark" | "system") => void; onAccent?: (value: "blue" | "gold") => void;
  }) {
    useNativeNavigationBlocked(true, "profile-pane");
    const appearanceRef = useRef<HTMLButtonElement>(null), accentRef = useRef<HTMLButtonElement>(null);
    const common = { owner: "synthetic-owner", context: "preferences", eligible, className: "preference-slot" };
    return <section data-testid="preference-scroll-root">
      <NativeChatChrome {...common} kind="appearance" value="system" onValueChange={onAppearance} focusRef={appearanceRef}>
        <button ref={appearanceRef}>Appearance fallback</button>
      </NativeChatChrome>
      <NativeChatChrome {...common} kind="accent" value="blue" onValueChange={onAccent} focusRef={accentRef}>
        <button ref={accentRef}>Accent fallback</button>
      </NativeChatChrome>
    </section>;
  }
  it("isolates public preference IDs and retires choices for scrolling, animations and a closed pane", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["appearance", "accent"], independentControls: true, inPlaceUpdates: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const appearance = this.dataset.nativeChromeSlot === "profile-appearance";
      const x = appearance ? 2 : 150, width = appearance ? 132 : 44;
      return { x, y: 60, width, height: 44, top: 60, left: x, right: x + width, bottom: 104, toJSON: () => ({}) };
    });
    const onAppearance = vi.fn(), onAccent = vi.fn();
    const view = render(<PreferenceHarness onAppearance={onAppearance} onAccent={onAccent} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const appearance = bridge.prepare.mock.calls.find(([p]) => p.kind === "appearance")![0];
    const accent = bridge.prepare.mock.calls.find(([p]) => p.kind === "accent")![0];
    expect(appearance).toMatchObject({ controlId: "profile-appearance", value: "system" });
    expect(accent).toMatchObject({ controlId: "profile-accent", value: "blue" });
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...appearance, sequence: 1, updateSequence: 0, privacyGeneration: 0, value: "dark" }));
    await waitFor(() => expect(onAppearance).toHaveBeenCalledWith("dark"));
    expect(onAccent).not.toHaveBeenCalled();
    const root = view.getByTestId("preference-scroll-root");
    fireEvent.scroll(root);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...accent, sequence: 1, updateSequence: 0, privacyGeneration: 0, value: "gold" }));
    expect(onAccent).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(4));
    const animation = (type: string) => Object.assign(new Event(type, { bubbles: true }), { animationName: "pane-exit" });
    fireEvent(root, animation("animationstart"));
    const preparations = bridge.prepare.mock.calls.length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(bridge.prepare).toHaveBeenCalledTimes(preparations); // No 150ms readmission during a 300ms sheet.
    fireEvent(root, animation("animationcancel"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(6));
    const latest = bridge.prepare.mock.calls.at(-1)![0];
    view.rerender(<PreferenceHarness eligible={false} onAppearance={onAppearance} onAccent={onAccent} />);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...latest, sequence: 2, updateSequence: 0, privacyGeneration: 0, value: "gold" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Accent fallback" })).toBeVisible());
    expect(onAccent).not.toHaveBeenCalled();
  });
  it.each(["stationary", "transform", "geometry"] as const)("admits %s preference geometry without bypassing initial motion recovery", async (initial) => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");
    const keyframeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "KeyframeEffect");
    class TransformEffect { getKeyframes() { return [{ transform: "translateX(10px)" }]; } }
    Object.defineProperty(globalThis, "KeyframeEffect", { configurable: true, value: TransformEffect });
    let moving = initial === "transform", geometryValid = initial !== "geometry";
    Object.defineProperty(HTMLElement.prototype, "getAnimations", { configurable: true, value: () => moving
      ? [{ playState: "running", effect: new TransformEffect() }] : [] });
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["appearance", "accent"], independentControls: true, inPlaceUpdates: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const appearance = this.dataset.nativeChromeSlot === "profile-appearance";
      const x = appearance ? 2 : 150, width = appearance ? 132 : 44, y = geometryValid ? 60 : -1;
      return { x, y, width, height: 44, top: y, left: x, right: x + width, bottom: y + 44, toJSON: () => ({}) };
    });
    try {
      const view = render(<PreferenceHarness />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      if (initial === "stationary") {
        expect(bridge.activate).toHaveBeenCalledTimes(2); // No 150ms artificial delay.
      } else {
        expect(bridge.prepare).not.toHaveBeenCalled();
        if (initial === "transform") {
          await act(async () => { await vi.advanceTimersByTimeAsync(350); });
          expect(bridge.prepare).not.toHaveBeenCalled(); // A pre-listener transform is still running.
        }
        moving = false; geometryValid = true;
        // No ResizeObserver or start/end notification: the existing settlement
        // owner must recover initially clipped/unmeasurable geometry.
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(bridge.activate).toHaveBeenCalledTimes(2);
      }
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    } finally {
      vi.useRealTimers();
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "getAnimations", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
      if (keyframeDescriptor) Object.defineProperty(globalThis, "KeyframeEffect", keyframeDescriptor);
      else Reflect.deleteProperty(globalThis, "KeyframeEffect");
    }
  });
  it.each(["agent-surface", "history"] as const)("exposes only allowlisted public %s rehearsal status with explicit Debug capability", async (kind) => {
    const capability = { contractVersion: 2, families: [kind], independentControls: true };
    const statusId = kind === "agent-surface" ? "native-selector-rehearsal-status" : "native-control-status-chat-history-toggle";
    const width = kind === "agent-surface" ? 116 : 44;
    bridge.getCapabilities.mockResolvedValue(capability);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width, height: 44, top: 60, left: 2, right: 2 + width, bottom: 104, toJSON: () => ({}),
    });
    bridge.prepare.mockRejectedValue(new Error("synthetic-private-response-must-not-appear"));
    const ordinary = render(<ChatHarness kind={kind} />);
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalled());
    expect(ordinary.queryByTestId(statusId)).toBeNull();
    ordinary.unmount();
    bridge.documentId = crypto.randomUUID();
    bridge.getCapabilities.mockResolvedValue({ ...capability, rehearsalDiagnostics: true });
    const rehearsal = render(<ChatHarness kind={kind} />);
    await waitFor(() => expect(rehearsal.getByTestId(statusId)).toHaveTextContent('"outcome":"rejected"'));
    const status = rehearsal.getByTestId(statusId).textContent!;
    const publicStatus = JSON.parse(status.replace("NATIVE_SELECTOR_STATUS ", ""));
    for (const key of ["overlayBlocked", "inertBlocked", "moving", "suppressed", "voiceBlocked", "documentHidden"]) {
      expect(typeof publicStatus[key]).toBe("boolean");
    }
    expect(status).toContain('"code":"other"');
    expect(status).not.toContain("synthetic-private-response");
    expect(status).not.toContain("synthetic-owner");
    expect(status).not.toContain("document-a");
    expect(status).not.toContain("vault-epoch");
  });
  it.each(["clipped", "inert"])("does not retain unchanged preference frames when their ancestor becomes %s", async (admission) => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["appearance", "accent"], independentControls: true, inPlaceUpdates: true });
    let clipped = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const parent = this.dataset.testid === "preference-scroll-root";
      const appearance = this.dataset.nativeChromeSlot === "profile-appearance";
      const x = parent || appearance ? 2 : 150, width = parent ? 300 : appearance ? 132 : 44;
      const height = parent && clipped ? 20 : 44;
      return { x, y: 60, width, height, top: 60, left: x, right: x + width, bottom: 60 + height, toJSON: () => ({}) };
    });
    const action = vi.fn();
    const view = render(<PreferenceHarness onAppearance={action} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const old = bridge.prepare.mock.calls.find(([p]) => p.kind === "appearance")![0];
    const root = view.getByTestId("preference-scroll-root");
    const retirements = bridge.retire.mock.calls.length;
    if (admission === "inert") root.setAttribute("inert", "");
    else { clipped = true; root.style.overflowY = "hidden"; }
    fireEvent(window, new Event("resize"));
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, updateSequence: 1, privacyGeneration: 0, value: "dark" }));
    await waitFor(() => expect(bridge.retire.mock.calls.length).toBeGreaterThan(retirements));
    await act(async () => { await Promise.resolve(); });
    expect(action).not.toHaveBeenCalled();
    expect(bridge.prepare).toHaveBeenCalledTimes(2);
  });
  it("updates a mounted selector without reinstalling and rejects choices before the latest ack", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["agent-surface"], independentControls: true, inPlaceUpdates: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width: 116, height: 44, top: 60, left: 2, right: 118, bottom: 104, toJSON: () => ({}),
    });
    const action = vi.fn();
    const view = render(<ChatHarness kind="agent-surface" value="one" onAction={action} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    const pending = deferred<ChromeUpdateAcknowledgement>();
    bridge.update.mockReturnValueOnce(pending.promise);
    view.rerender(<ChatHarness kind="agent-surface" value="puppy" onAction={action} />);
    await waitFor(() => expect(bridge.update).toHaveBeenCalledOnce());
    const update = bridge.update.mock.calls.at(-1)![0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...update, value: "puppy", sequence: 1, privacyGeneration: 0 }));
    expect(action).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(update); await pending.promise; });
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...update, value: "puppy", sequence: 2, privacyGeneration: 0 }));
    await waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith("puppy"));
    expect(bridge.prepare).toHaveBeenCalledOnce(); expect(bridge.activate).toHaveBeenCalledOnce();
  });
  it("preserves CSS secondary-label color and alpha, fencing unresolved or changed utility colors", async () => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width: 44, height: 44, top: 60, left: 2, right: 46, bottom: 104, toJSON: () => ({}),
    });
    document.documentElement.style.setProperty("--muted-foreground", "oklch(0.6 0.005 264)");
    const view = render(<ChatHarness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const light = bridge.prepare.mock.calls.at(-1)![0];
    expect(light.foregroundHex).toMatch(/^#[0-9a-f]{6}$/);
    expect(light.foregroundHex).not.toBe(light.accentHex);
    expect(isCurrentNativeControlAppearance(light, "secondary")).toBe(true);
    // The action check reads committed CSS before observer publication.
    document.documentElement.style.setProperty("--muted-foreground", "rgba(235, 235, 245, 0.72)");
    expect(isCurrentNativeControlAppearance(light, "secondary")).toBe(false);
    act(() => document.documentElement.classList.add("dark"));
    await waitFor(() => expect(bridge.prepare.mock.calls.at(-1)![0]).toMatchObject({
      appearance: "dark", foregroundHex: "#ebebf5b8",
    }));
    const dark = bridge.prepare.mock.calls.at(-1)![0];
    document.documentElement.style.setProperty("--muted-foreground", "var(--unresolved-utility)");
    expect(isCurrentNativeControlAppearance(dark, "secondary")).toBe(false);
    act(() => document.documentElement.setAttribute("data-accent", "gold"));
    await waitFor(() => expect(view.getByRole("button", { name: "Authored history" })).toBeVisible());
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false);
  });
  it.each([false, true])("isolates simultaneous controls and retires history attention with retained hosts %s", async (retainedControls) => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history", "agent-surface"],
      independentControls: true, inPlaceUpdates: true, retainedControls });
    await getNativeChromeCapabilities();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const selector = this.textContent?.includes("agent-surface");
      return { x: selector ? 100 : 2, y: 60, width: selector ? 100 : 44, height: 44,
        top: 60, left: selector ? 100 : 2, right: selector ? 200 : 46, bottom: 104, toJSON: () => ({}) };
    });
    const onAction = vi.fn();
    const view = render(<><ChatHarness onAction={onAction} /><ChatHarness kind="agent-surface" /></>);
    bridge.activate.mockImplementation(async (identity) => {
      const kind = identity.controlId === "chat-history-toggle" ? "history" : "agent-surface";
      const button = view.getByText(`Authored ${kind}`);
      expect(button.parentElement).toHaveAttribute("inert");
      expect(button.parentElement).toHaveAttribute("aria-hidden", "true");
      expect(button.parentElement).toHaveStyle({ visibility: "hidden" });
      return { ...identity, phase: "active" };
    });
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    expect(bridge.prepare.mock.calls.find(([item]) => item.kind === "history")![0].foregroundHex).toBe("#8e8e93");
    expect(bridge.prepare.mock.calls.find(([item]) => item.kind === "agent-surface")![0].foregroundHex).not.toBe("#8e8e93");
    const old = bridge.activate.mock.calls.find(([identity]) => identity.controlId === "chat-history-toggle")![0];
    const confirmation = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(confirmation.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, privacyGeneration: 0 }));
    view.rerender(<><ChatHarness pendingAttention={1} onAction={onAction} /><ChatHarness kind="agent-surface" /></>);
    await act(async () => { confirmation.resolve({ valid: true }); });
    expect(onAction).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByRole("button", { name: "Authored history" })).toBeVisible());
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false);
    expect(hasOutstandingNativeChrome("chat-agent-surface")).toBe(true);
    expect(bridge.prepare.mock.calls.filter(([item]) => item.kind === "history")).toHaveLength(1);
    view.rerender(<><ChatHarness onAction={onAction} /><ChatHarness kind="agent-surface" /></>);
    await waitFor(() => expect(bridge.prepare.mock.calls.filter(([item]) => item.kind === "history")).toHaveLength(2));
  });
  it.each([84, 88, 100, 321])("measures the selector's authored %s-point width instead of guessing a header size", async (width) => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 60, width, height: 44, top: 60, left: 100, right: 100 + width, bottom: 104, toJSON: () => ({}),
    });
    const view = render(<ChatHarness kind="agent-surface" />);
    await waitFor(() => expect(bridge.getCapabilities).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    if (width >= 88 && width <= 320) {
      await waitFor(() => expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-surface", value: "one", frame: expect.objectContaining({ width }) })));
    } else {
      expect(bridge.prepare).not.toHaveBeenCalled();
      expect(view.getByRole("button", { name: "Authored agent-surface" })).toBeVisible();
    }
  });
  it("keeps selection React-owned and rejects an old owner/value during confirmation", async () => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 60, width: 100, height: 44, top: 60, left: 100, right: 200, bottom: 104, toJSON: () => ({}),
    });
    const onAction = vi.fn();
    const view = render(<ChatHarness kind="agent-surface" onAction={onAction} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const old = bridge.activate.mock.calls.at(-1)![0];
    const pending = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(pending.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, value: "puppy", sequence: 1, privacyGeneration: 0 }));
    view.rerender(<ChatHarness kind="agent-surface" owner="replacement-owner" value="puppy" onAction={onAction} />);
    await act(async () => { pending.resolve({ valid: true }); });
    expect(onAction).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const fresh = bridge.activate.mock.calls.at(-1)![0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...fresh, value: "one", sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("one"));
    expect(bridge.prepare.mock.calls.at(-1)![0].value).toBe("puppy"); // No second selector state.
  });
  it.each(["synthetic-owner", ""])("restores an admitted web opener without native/vault eligibility (owner=%s)", async owner => {
    bridge.platform = "web";
    vi.mocked(customNativePresentationEnabled).mockReturnValue(false);
    const handle = createRef<NativeChatChromeHandle>();
    const view = render(<ChatHarness owner={owner} eligible={false} handle={handle} />);
    const opener = view.getByRole("button", { name: "Authored history" });
    await act(async () => { expect(await handle.current!.restoreFocus()).toBe(true); });
    expect(opener).toHaveFocus();
    opener.blur();
    view.container.setAttribute("inert", "");
    await act(async () => { expect(await handle.current!.restoreFocus()).toBe(false); });
    expect(opener).not.toHaveFocus();
    expect(bridge.prepare).not.toHaveBeenCalled();
    expect(bridge.restoreFocus).not.toHaveBeenCalled();
  });

  it("restores authored focus only after native retirement and holds fallback until blur", async () => {
    admitChat(); measureSlot();
    const handle = createRef<NativeChatChromeHandle>();
    const view = render(<ChatHarness handle={handle} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const retired = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(retired.promise);
    const firstRetirement = bridge.retire.mock.calls.length;
    let result!: Promise<boolean>;
    act(() => { result = handle.current!.restoreFocus(); });
    const identity = bridge.retire.mock.calls[firstRetirement][0];
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();
    await act(async () => { retired.resolve({ ...identity, phase: "retired" }); expect(await result).toBe(true); });
    const button = view.getByRole("button", { name: "Authored history" });
    await waitFor(() => expect(button).toHaveFocus());
    const preparations = bridge.prepare.mock.calls.length;
    fireEvent(window, new Event("resize"));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.prepare).toHaveBeenCalledTimes(preparations);
    act(() => { button.blur(); });
    await waitFor(() => expect(bridge.prepare.mock.calls.length).toBeGreaterThan(preparations));
  });

  it("does not latch an untransferred focus hold after rejected retirement", async () => {
    admitChat(); measureSlot();
    const handle = createRef<NativeChatChromeHandle>();
    const action = vi.fn();
    const view = render(<ChatHarness handle={handle} onAction={action} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const preparations = bridge.prepare.mock.calls.length;
    bridge.retire.mockRejectedValueOnce(new Error("NATIVE_CHROME_ACK_UNCERTAIN"));
    await act(async () => { expect(await handle.current!.restoreFocus()).toBe(false); });
    // Recovery may confirm retirement, not replay the authored operation or
    // focus a control beneath an uncertain native presentation.
    await waitFor(() => expect(bridge.prepare.mock.calls.length).toBeGreaterThan(preparations));
    expect(action).not.toHaveBeenCalled();
    expect(view.getByText("Authored history")).not.toHaveFocus();
    await waitFor(() => expect(view.getByText("Authored history").parentElement).toHaveAttribute("inert"));
  });

  it("waits for current History admission instead of retiring it for focus, and rejects covered focus", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"], independentControls: true,
      inPlaceUpdates: true, focusReturn: true, retainedControls: true });
    const preparation = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValueOnce(preparation.promise);
    const handle = createRef<NativeChatChromeHandle>();
    function Blocker({ open }: { open: boolean }) { useNativeNavigationBlocked(open); return null; }
    const view = render(<><ChatHarness handle={handle} /><Blocker open={false} /></>);
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledOnce());
    const projection = bridge.prepare.mock.calls[0][0];
    const retirements = bridge.retire.mock.calls.length;
    let focus!: Promise<boolean>;
    act(() => { focus = handle.current!.restoreFocus(true); });
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(bridge.restoreFocus).not.toHaveBeenCalled();
    await act(async () => { preparation.resolve({ ...projection, phase: "prepared", frame: projection.frame }); });
    await waitFor(() => expect(bridge.restoreFocus).toHaveBeenCalledOnce());
    expect(await focus).toBe(true);
    expect(bridge.prepare).toHaveBeenCalledOnce();
    expect(view.getByText("Authored history")).not.toBeVisible();
    view.rerender(<><ChatHarness handle={handle} /><Blocker open /></>);
    await waitFor(() => expect(bridge.suspend).toHaveBeenCalled());
    const coveredRetirements = bridge.retire.mock.calls.length;
    await act(async () => { expect(await handle.current!.restoreFocus(true)).toBe(false); });
    expect(bridge.retire).toHaveBeenCalledTimes(coveredRetirements);
    view.rerender(<><ChatHarness handle={handle} /><Blocker open={false} /></>);
    await waitFor(() => expect(bridge.activate.mock.calls.length).toBeGreaterThan(1));
    expect(view.getByText("Authored history")).not.toBeVisible();
  });

  it("keeps native History installed after confirmed keyboard cancellation of focus", async () => {
    admitChat(); measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"], independentControls: true,
      inPlaceUpdates: true, focusReturn: true });
    const handle = createRef<NativeChatChromeHandle>();
    const view = render(<ChatHarness handle={handle} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const lifecycle = [bridge.retire.mock.calls.length, bridge.prepare.mock.calls.length, bridge.activate.mock.calls.length];
    bridge.restoreFocus.mockImplementationOnce(async event => ({ ...event, restored: false, cancellation: "keyboard" }));
    await act(async () => { expect(await handle.current!.restoreFocus(true)).toBe(false); });
    expect([bridge.retire.mock.calls.length, bridge.prepare.mock.calls.length, bridge.activate.mock.calls.length]).toEqual(lifecycle);
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();
    await act(async () => { expect(await handle.current!.restoreFocus(true)).toBe(true); });
    expect([bridge.retire.mock.calls.length, bridge.prepare.mock.calls.length, bridge.activate.mock.calls.length]).toEqual(lifecycle);
  });

  it("returns native History focus without latching DOM fallback and rejects stale owner focus", async () => {
    admitChat(); measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"], independentControls: true,
      inPlaceUpdates: true, focusReturn: true });
    const handle = createRef<NativeChatChromeHandle>();
    const view = render(<ChatHarness handle={handle} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const lifecycle = [bridge.retire.mock.calls.length, bridge.prepare.mock.calls.length, bridge.activate.mock.calls.length];
    let result!: Promise<boolean>;
    act(() => { result = handle.current!.restoreFocus(true); });
    await waitFor(() => expect(bridge.restoreFocus).toHaveBeenCalledOnce());
    expect(await result).toBe(true);
    expect([bridge.retire.mock.calls.length, bridge.prepare.mock.calls.length, bridge.activate.mock.calls.length]).toEqual(lifecycle);
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();
    expect(bridge.restoreFocus.mock.calls[0][0]).toMatchObject({
      controlId: "chat-history-toggle", updateSequence: 0, focusSequence: 1,
    });
    const pending = deferred<Record<string, unknown>>();
    bridge.restoreFocus.mockReturnValueOnce(pending.promise);
    act(() => { result = handle.current!.restoreFocus(true); });
    await waitFor(() => expect(bridge.restoreFocus).toHaveBeenCalledTimes(2));
    const old = bridge.restoreFocus.mock.calls.at(-1)![0];
    view.rerender(<ChatHarness handle={handle} owner="replacement-owner" />);
    await act(async () => { pending.resolve({ ...old, restored: true }); });
    expect(await result).toBe(false);
    expect(view.getByText("Authored history")).not.toHaveFocus();
    await waitFor(() => expect(bridge.activate.mock.calls.at(-1)?.[0].ownerEpoch).not.toBe(old.ownerEpoch));
    const preparations = bridge.prepare.mock.calls.length;
    const preparation = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValueOnce(preparation.promise);
    // A moved slot cannot take the retained-focus path, even before resize
    // notification. Keep failed-preparation recovery on this real boundary.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 3, y: 60, width: 44, height: 44, top: 60, left: 3, right: 47, bottom: 104, toJSON: () => ({}),
    });
    act(() => { result = handle.current!.restoreFocus(true); });
    await waitFor(() => expect(bridge.prepare.mock.calls.length).toBeGreaterThan(preparations));
    expect(view.getByText("Authored history")).not.toBeVisible();
    await act(async () => { preparation.reject(new Error("NATIVE_CHROME_LAYOUT_UNCONFIRMED")); });
    expect(await result).toBe(true);
    expect(view.getByRole("button", { name: "Authored history" })).toHaveFocus();
    const activations = bridge.activate.mock.calls.length;
    act(() => { view.getByRole("button", { name: "Authored history" }).blur(); });
    await waitFor(() => expect(bridge.activate.mock.calls.length).toBeGreaterThan(activations));
    const delayedFocus = deferred<Record<string, unknown>>();
    bridge.restoreFocus.mockReturnValueOnce(delayedFocus.promise);
    const focusCalls = bridge.restoreFocus.mock.calls.length;
    act(() => { result = handle.current!.restoreFocus(true); });
    await waitFor(() => expect(bridge.restoreFocus.mock.calls.length).toBe(focusCalls + 1));
    const resized = bridge.restoreFocus.mock.calls.at(-1)![0];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 4, y: 60, width: 44, height: 44, top: 60, left: 4, right: 48, bottom: 104, toJSON: () => ({}),
    });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(bridge.restoreFocus.mock.calls.length).toBe(focusCalls + 2));
    expect(await result).toBe(true);
    await act(async () => { delayedFocus.resolve({ ...resized, restored: true }); });
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();

    const displacedFocus = deferred<Record<string, unknown>>();
    bridge.restoreFocus.mockReturnValueOnce(displacedFocus.promise);
    act(() => { result = handle.current!.restoreFocus(true); });
    const displaced = bridge.restoreFocus.mock.calls.at(-1)![0];
    const onReplacement = vi.fn();
    const replacementHandle = createRef<NativeChatChromeHandle>();
    const replacement = render(<ChatHarness handle={replacementHandle} owner="new-mounted-owner" onAction={onReplacement} />);
    await waitFor(() => expect(bridge.activate.mock.calls.at(-1)?.[0].ownerEpoch).not.toBe(displaced.ownerEpoch));
    const replacementIdentity = bridge.activate.mock.calls.at(-1)![0];
    const retirements = bridge.retire.mock.calls.length;
    await act(async () => { displacedFocus.resolve({ ...displaced, restored: true }); });
    expect(await result).toBe(false);
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();
    expect(view.container.querySelector("button")?.parentElement).toHaveAttribute("inert");
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...replacementIdentity, sequence: 1, privacyGeneration: 0, updateSequence: 0 }));
    await waitFor(() => expect(onReplacement).toHaveBeenCalledOnce());

    const oldDocumentFocus = deferred<Record<string, unknown>>();
    bridge.restoreFocus.mockReturnValueOnce(oldDocumentFocus.promise);
    act(() => { result = replacementHandle.current!.restoreFocus(true); });
    const oldDocument = bridge.restoreFocus.mock.calls.at(-1)![0];
    bridge.documentId = crypto.randomUUID();
    await act(async () => { oldDocumentFocus.resolve({ ...oldDocument, restored: true }); });
    expect(await result).toBe(false);
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(replacement.queryByRole("button", { name: "Authored history" })).toBeNull();
  });

  it("keeps Drive attention accessible in the actual opener and out of native projections", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"], independentControls: true });
    const fallback = createRef<HTMLButtonElement>();
    const opener = (pendingAttention: number, open = false, showAttentionDot = true) => <NativeHistoryOpener
      owner="synthetic-owner" context="chat:stable" eligible open={open}
      pendingAttention={pendingAttention} showAttentionDot={showAttentionDot} focusRef={fallback} onActivate={vi.fn()} />;
    const view = render(opener(1));
    await waitFor(() => expect(bridge.getCapabilities).toHaveBeenCalled());
    expect(view.getByRole("button", { name: "Open chat history, 1 Drive review needs you" })).toBeVisible();
    expect(bridge.prepare).not.toHaveBeenCalled();
    view.rerender(opener(2));
    expect(view.getByRole("button", { name: "Open chat history, 2 Drive reviews need you" })).toBeVisible();
    expect(bridge.prepare).not.toHaveBeenCalled();
    view.rerender(opener(2, false, false));
    expect(view.getByRole("button", { name: "Open chat history, 2 Drive reviews need you" })).toBeVisible();
    view.rerender(opener(2, true));
    expect(fallback.current).toHaveAttribute("aria-label", "Close chat history");
    expect(fallback.current).toHaveAttribute("aria-expanded", "true");
    expect(fallback.current).not.toBeVisible();
    expect(bridge.prepare).not.toHaveBeenCalled();
    view.rerender(opener(0));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    expect(fallback.current).toHaveAttribute("aria-label", "Open chat history");
    expect(bridge.prepare.mock.calls[0][0]).toMatchObject({ kind: "history", label: "Chat history" });
    expect(bridge.prepare.mock.calls[0][0]).not.toHaveProperty("pendingAttention");
    expect(view.queryByRole("button", { name: "Open chat history" })).toBeNull();
  });

  it.each([1, 0])("returns actual History opener focus after a DOM-owned surface becomes native eligible (click detail %s)", async (detail) => {
    measureSlot();
    const discovery = deferred<{ contractVersion: number; families: ["history"]; independentControls: boolean; focusReturn: boolean }>();
    bridge.getCapabilities.mockReturnValueOnce(discovery.promise);
    function OpenerJourney() {
      const [open, setOpen] = useState(false);
      const [didOpen, setDidOpen] = useState(false);
      const preference = useRef(false);
      const handle = useRef<NativeChatChromeHandle>(null), fallback = useRef<HTMLButtonElement>(null);
      useEffect(() => {
        if (!open && didOpen) void handle.current?.restoreFocus(preference.current);
      }, [open, didOpen]);
      return <>
        <NativeHistoryOpener owner="synthetic-owner" context="chat:stable" eligible={didOpen} open={open}
          pendingAttention={0} showAttentionDot focusRef={fallback} ref={handle}
          onActivate={(preferNative) => { preference.current = preferNative; setDidOpen(true); setOpen(true); }} />
        {open ? <NativeHistoryClose owner="synthetic-owner" context="history:stable" onClose={() => setOpen(false)} /> : null}
      </>;
    }
    const view = render(<OpenerJourney />);
    // An initially unqualified surface keeps its authored DOM control. Cold,
    // eligible surfaces are concealed instead (the discovery regression above).
    fireEvent.click(view.getByRole("button", { name: "Open chat history" }), { detail });
    await act(async () => discovery.resolve({ contractVersion: 2, families: ["history"], independentControls: true, focusReturn: true }));
    // Use the actual authored Close while it is still settling; do not infer
    // a control from DOM or call restoreFocus directly as the interaction.
    const close = view.getByRole("button", { name: "Close chat history" });
    view.rerender(<OpenerJourney />);
    expect(view.getByRole("button", { name: "Close chat history" })).toBe(close);
    // Close is part of the React-owned drawer, not a separately installed
    // native button. The opener may acquire its own native lease.
    expect(bridge.prepare.mock.calls.filter(([state]) => state.kind === "close")).toHaveLength(0);
    fireEvent.click(close);
    if (detail > 0) {
      await waitFor(() => expect(bridge.restoreFocus).toHaveBeenCalledOnce());
      expect(view.queryByRole("button", { name: "Open chat history" })).toBeNull();
    } else {
      const opener = view.getByRole("button", { name: "Open chat history" });
      await waitFor(() => expect(opener).toHaveFocus());
      expect(bridge.restoreFocus).not.toHaveBeenCalled();
      const prepared = bridge.prepare.mock.calls.length;
      fireEvent(window, new Event("resize"));
      await act(async () => { await Promise.resolve(); });
      expect(bridge.prepare).toHaveBeenCalledTimes(prepared);
      act(() => opener.blur());
      await waitFor(() => expect(bridge.activate).toHaveBeenCalled());
    }
  });

  function Harness({ context = "/one/profile/security", owner = "synthetic-owner", suppressed = false, onBack = vi.fn(), eligible = true }) {
    useSessionChromeSuppression(suppressed);
    return <NativeShellBack label="Go back" onBack={onBack} owner={owner} context={context} eligible={eligible} />;
  }
  function measureSlot() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width: 44, height: 44, top: 60, left: 2, right: 46, bottom: 104, toJSON: () => ({}),
    });
  }

  function ProfileBackControl({ context, action, owner, suppressed, eligible }: {
    context: string; action: () => void; owner: string; suppressed: boolean; eligible: boolean;
  }) {
    useNativeNavigationBlocked(true, "profile-pane");
    useSessionChromeSuppression(suppressed);
    const focusRef = useRef<HTMLButtonElement>(null);
    return <NativeChatChrome kind="profile-back" label="Back in Profile" owner={owner} context={context}
      eligible={eligible} focusRef={focusRef} className="profile-back-slot" onActivate={action}>
      <button ref={focusRef}>Back in Profile</button>
    </NativeChatChrome>;
  }
  function retainedControl(kind: "back" | "history" | "profile-back", context: string, action = vi.fn(), owner = "synthetic-owner", suppressed = false, eligible = true) {
    if (kind === "profile-back") return <ProfileBackControl {...{ context, action, owner, suppressed, eligible }} />;
    return kind === "back" ? <Harness context={context} owner={owner} onBack={action} suppressed={suppressed} eligible={eligible} />
      : <ChatHarness context={context} owner={owner} onAction={action} suppressed={suppressed} eligible={eligible} />;
  }
  function admitReplacement(kind: "back" | "history" | "profile-back", retainedControls = false) {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [kind], independentControls: true,
      backReplacement: true, profileBackReplacement: true, historyReplacement: true, inPlaceUpdates: true, retainedControls });
    return kind === "history" ? bridge.prepareHistoryReplacement : bridge.prepareBackReplacement;
  }

  it("retains pane-bound Back on nested binding changes but retires on a changed pane", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back"], independentControls: true,
      coherentPresentation: true, retainedControls: true, inPlaceUpdates: true, profileBackReplacement: true });
    const oldAction = vi.fn(), nextAction = vi.fn();
    function Back({ context, generation = 1, action }: { context: string; generation?: number; action: () => void }) {
      const ref = useRef<HTMLButtonElement>(null);
      return <NativeChatChrome kind="profile-back" label="Back in Profile" owner="synthetic-owner" context={context}
        eligible focusRef={ref} onActivate={action} contentPane={{ documentId: bridge.documentId, ownerEpoch: "pane-owner", generation: 1, privacyGeneration: generation }}>
        <button ref={ref}>Back in Profile</button>
      </NativeChatChrome>;
    }
    const view = render(<Back context="preferences" action={oldAction} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const old = bridge.prepare.mock.calls[0][0];
    const retired = bridge.retire.mock.calls.length;
    view.rerender(<Back context="voice" action={nextAction} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    expect(bridge.suspend).not.toHaveBeenCalled();
    expect(bridge.retire).toHaveBeenCalledTimes(retired);
    expect(bridge.prepareBackReplacement).toHaveBeenCalledOnce();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    expect(bridge.confirmChoice).not.toHaveBeenCalled();
    const next = bridge.prepareBackReplacement.mock.calls[0][0];
    expect(next.contentPane).toEqual(old.contentPane);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...next, sequence: 2, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(nextAction).toHaveBeenCalledOnce());
    expect(oldAction).not.toHaveBeenCalled();
    view.rerender(<Back context="voice" generation={2} action={nextAction} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(3));
    expect(bridge.retire).toHaveBeenCalledTimes(retired + 1);
    expect(bridge.prepareBackReplacement).toHaveBeenCalledOnce();
    const rebound = bridge.prepare.mock.calls.at(-1)![0];
    expect(rebound.contentPane).toEqual({ ...old.contentPane, privacyGeneration: 2 });
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...next, sequence: 3, updateSequence: 0, privacyGeneration: 0 }));
    expect(nextAction).toHaveBeenCalledOnce();
  });

  it.each([
    ["back", false], ["history", false], ["profile-back", false],
    ["history", true], ["profile-back", true],
  ] as const)("hands off same-frame %s presentation without hiding or removal (retained=%s) while expiring pending old actions", async (kind, retained) => {
    measureSlot();
    const replacement = admitReplacement(kind, retained);
    const oldAction = vi.fn(), newAction = vi.fn();
    const view = render(retainedControl(kind, "original", oldAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    const old = bridge.prepare.mock.calls[0][0];
    const confirmation = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(confirmation.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(bridge.confirmChoice).toHaveBeenCalledOnce());
    const handoff = deferred<ChromeAcknowledgement>();
    replacement.mockReturnValueOnce(handoff.promise);
    const retirements = bridge.retire.mock.calls.length;
    const suspensions = bridge.suspend.mock.calls.length;
    view.rerender(retainedControl(kind, "replacement", newAction));
    await waitFor(() => expect(replacement).toHaveBeenCalledOnce());
    const next = replacement.mock.calls[0][0];
    expect(next).toMatchObject({ previousRevision: old.revision, ownerEpoch: old.ownerEpoch, frame: old.frame });
    expect(next.revision).toBeGreaterThan(old.revision);
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(bridge.suspend).toHaveBeenCalledTimes(suspensions);
    expect(view.getByRole("button", { hidden: true })).not.toBeVisible();
    await act(async () => confirmation.resolve({ valid: true }));
    expect(oldAction).not.toHaveBeenCalled(); expect(newAction).not.toHaveBeenCalled();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...next, sequence: 2, updateSequence: 0, privacyGeneration: 0 }));
    expect(bridge.confirmChoice).toHaveBeenCalledOnce(); // Prepared is not interactive.
    await act(async () => handoff.resolve({ ...next, phase: "prepared" }));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 3, updateSequence: 0, privacyGeneration: 0 }));
    expect(bridge.confirmChoice).toHaveBeenCalledOnce();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...next, sequence: 3, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(newAction).toHaveBeenCalledOnce());
    expect(oldAction).not.toHaveBeenCalled();
    view.unmount();
    // No route-owned control may retain visible pixels after its owner unmounts.
    // Ordinary drawer coverage keeps that owner mounted and is tested separately.
    await waitFor(() => expect(hasOutstandingNativeChrome(old.controlId)).toBe(false));
  });

  it.each(["history", "agent-surface"] as const)("retires route-absent %s but preserves its covered mounted host", async kind => {
    measureSlot();
    if (kind === "agent-surface") vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 2, y: 60, width: 94, height: 44, top: 60, left: 2, right: 96, bottom: 104, toJSON: () => ({}),
    } as DOMRect);
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [kind], independentControls: true,
      coherentPresentation: true, retainedControls: true, inPlaceUpdates: true });
    const action = vi.fn();
    function RouteControl({ eligible = true, covered = false }: { eligible?: boolean; covered?: boolean }) {
      useNativeNavigationBlocked(covered);
      const focusRef = useRef<HTMLButtonElement>(null);
      const shared = { owner: "owner-a", context: "chat", eligible, focusRef, className: "chat-control" };
      return kind === "history"
        ? <NativeChatChrome {...shared} kind="history" pendingAttention={0} onActivate={action}><button ref={focusRef}>History</button></NativeChatChrome>
        : <NativeChatChrome {...shared} kind="agent-surface" value="one" onValueChange={action}><button ref={focusRef}>Agent</button></NativeChatChrome>;
    }
    const view = render(<RouteControl />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const controlId = bridge.prepare.mock.calls[0][0].controlId;
    const initialRetirements = bridge.retire.mock.calls.length;
    view.rerender(<RouteControl covered />);
    await waitFor(() => expect(bridge.update.mock.calls.at(-1)?.[0].enabled).toBe(false));
    if (kind === "history") {
      act(() => bridge.callbacks.get("choiceRequested")?.({ ...bridge.update.mock.calls.at(-1)![0], sequence: 1, privacyGeneration: 0 }));
      expect(action).not.toHaveBeenCalled();
    }
    expect(bridge.retire).toHaveBeenCalledTimes(initialRetirements);
    expect(bridge.prepare).toHaveBeenCalledOnce();
    view.rerender(<RouteControl />);
    await waitFor(() => expect(bridge.update.mock.calls.at(-1)?.[0].enabled).toBe(true));
    if (kind === "history") {
      await act(async () => { await Promise.resolve(); });
      const admitted = bridge.update.mock.calls.at(-1)![0];
      // Event-time metadata can withdraw authority before another React render.
      // Native visibility/enabled state alone must not permit the old choice.
      voiceSurface.current = { interactionLayer: { blocksUnderlyingActions: true } };
      act(() => bridge.callbacks.get("choiceRequested")?.({ ...admitted, sequence: 2, privacyGeneration: 0 }));
      expect(action).not.toHaveBeenCalled();
      expect(bridge.confirmChoice).not.toHaveBeenCalled();
      voiceSurface.current = null;
      act(() => bridge.callbacks.get("choiceRequested")?.({ ...admitted, sequence: 3, privacyGeneration: 0 }));
      await waitFor(() => expect(action).toHaveBeenCalledOnce());
      expect(bridge.confirmChoice).toHaveBeenCalledOnce();
    }
    expect(bridge.prepare).toHaveBeenCalledOnce();
    expect(bridge.activate).toHaveBeenCalledOnce();
    view.rerender(<RouteControl eligible={false} />);
    await waitFor(() => expect(hasOutstandingNativeChrome(controlId)).toBe(false));
    expect(bridge.suspend).not.toHaveBeenCalled();
    view.rerender(<RouteControl />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    view.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(controlId)).toBe(false));
    expect(bridge.suspend).not.toHaveBeenCalled();
  });

  it.each(["chat-attachment", "chat-drive-review"] as const)("admits Back only for its authored %s layer", async layer => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back"], independentControls: true,
      coherentPresentation: true, retainedControls: true, inPlaceUpdates: true });
    const back = vi.fn();
    function Feature({ nested = false }: { nested?: boolean }) {
      useNativeNavigationBlocked(nested);
      return <NativeFeaturePage open title="Synthetic detail" owner="owner-a" context="synthetic" layer={layer} onBack={back}>
        <p>Public fixture</p>
      </NativeFeaturePage>;
    }
    const view = render(<Feature />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    const projection = bridge.prepare.mock.calls[0][0];
    const updateSequence = bridge.update.mock.calls.at(-1)?.[0].updateSequence ?? 0;
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...projection, sequence: 1, updateSequence, privacyGeneration: 0 }));
    await waitFor(() => expect(back).toHaveBeenCalledOnce());
    view.rerender(<Feature nested />);
    await waitFor(() => expect(bridge.update.mock.calls.at(-1)?.[0].enabled).toBe(false));
    const blocked = bridge.update.mock.calls.at(-1)![0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...projection, sequence: 2, updateSequence: blocked.updateSequence, privacyGeneration: 0 }));
    expect(back).toHaveBeenCalledOnce();
    expect(bridge.confirmChoice).toHaveBeenCalledOnce();
  });

  it.each([ ["back", "refused"], ["back", "uncertain"], ["history", "refused"], ["history", "uncertain"], ["profile-back", "refused"], ["profile-back", "uncertain"] ] as const)("hard-retires either revision after %s %s replacement before restoring DOM", async (kind, outcome) => {
    measureSlot();
    const replacement = admitReplacement(kind);
    const view = render(retainedControl(kind, "original"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    replacement.mockRejectedValueOnce(new Error(outcome === "refused" ? "NATIVE_CHROME_REPLACEMENT_REFUSED" : "NATIVE_CHROME_ACK_UNCERTAIN"));
    const removed = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(removed.promise);
    const retirements = bridge.retire.mock.calls.length;
    view.rerender(retainedControl(kind, "replacement"));
    await waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(retirements + 1));
    const retirement = bridge.retire.mock.calls.at(-1)![0];
    expect(retirement.targetRevision).toBeUndefined(); // Refusal may leave the predecessor.
    expect(view.getByRole("button", { hidden: true })).not.toBeVisible();
    await act(async () => removed.resolve({ ...retirement, phase: "retired" }));
    await waitFor(() => expect(view.getByRole("button")).toBeVisible());
    expect(replacement).toHaveBeenCalledOnce(); // No retry/replay.
  });

  it.each(["back", "history", "profile-back"] as const)("removes pending %s handoff on unmount and cannot resurrect it on a late acknowledgement", async (kind) => {
    measureSlot();
    const replacement = admitReplacement(kind);
    const view = render(retainedControl(kind, "original"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const handoff = deferred<ChromeAcknowledgement>();
    replacement.mockReturnValueOnce(handoff.promise);
    view.rerender(retainedControl(kind, "replacement"));
    await waitFor(() => expect(replacement).toHaveBeenCalledOnce());
    const next = replacement.mock.calls[0][0];
    view.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(next.controlId)).toBe(false));
    expect(bridge.retire.mock.calls.at(-1)![0].targetRevision).toBeUndefined();
    await act(async () => handoff.resolve({ ...next, phase: "prepared" }));
    expect(bridge.activate).toHaveBeenCalledOnce();
  });

  it.each([
    ["back", "activation"], ["history", "activation"],
    ["back", "update"], ["history", "update"],
  ] as const)("keeps displaced %s fallback concealed after late %s failure", async (kind, phase) => {
    measureSlot();
    admitReplacement(kind);
    const pending = deferred<ChromeAcknowledgement>();
    if (phase === "activation") bridge.activate.mockReturnValueOnce(pending.promise);
    const oldAction = vi.fn(), currentAction = vi.fn();
    const previous = render(retainedControl(kind, "previous", oldAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    if (phase === "update") {
      bridge.update.mockReturnValueOnce(pending.promise);
      act(() => {
        document.documentElement.style.setProperty("--app-accent", "#667788");
        writeAccent("gold");
      });
      await waitFor(() => expect(bridge.update).toHaveBeenCalledOnce());
    }
    const fallback = within(previous.container).getByRole("button", { hidden: true });
    const focus = vi.spyOn(fallback, "focus");
    const currentView = render(retainedControl(kind, "current", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const currentControl = bridge.prepare.mock.calls.at(-1)![0];
    const retirements = bridge.retire.mock.calls.length;
    await act(async () => pending.reject(new Error("NATIVE_CHROME_ACK_UNCERTAIN")));
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(fallback).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(true);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...currentControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledOnce());
    expect(oldAction).not.toHaveBeenCalled();
    previous.unmount(); currentView.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(false));
  });

  it.each(["back", "history"] as const)("does not remove a newer mounted %s control when its predecessor becomes inactive or unmounts", async (kind) => {
    measureSlot();
    admitReplacement(kind);
    const oldAction = vi.fn(), currentAction = vi.fn();
    const previous = render(retainedControl(kind, "previous", oldAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const currentView = render(retainedControl(kind, "current", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const currentControl = bridge.prepare.mock.calls.at(-1)![0];
    const removals = bridge.retire.mock.calls.length;
    previous.rerender(retainedControl(kind, "previous", oldAction, "synthetic-owner", false, false));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    expect(within(previous.container).getByRole("button", { hidden: true })).not.toBeVisible();
    expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(true);
    previous.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(true);
    const currentDocument = bridge.documentId;
    bridge.documentId = crypto.randomUUID(); // Old-document cleanup cannot reserve a new-document tombstone.
    await retireOwnedNativeChrome(currentControl);
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    bridge.documentId = currentDocument;
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...currentControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledOnce());
    expect(oldAction).not.toHaveBeenCalled();
    currentView.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(false));

    // The predecessor's own removal can fail after a newer mount takes over.
    // Recovery must not turn that delayed failure into unqualified removal.
    const waiting = render(retainedControl(kind, "waiting", oldAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(3));
    const removal = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(removal.promise);
    const beforeRemoval = bridge.retire.mock.calls.length;
    waiting.rerender(retainedControl(kind, "waiting", oldAction, "synthetic-owner", false, false));
    await waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(beforeRemoval + 1));
    const latestView = render(retainedControl(kind, "latest", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(4));
    const latestControl = bridge.prepare.mock.calls.at(-1)![0];
    const beforeFailure = bridge.retire.mock.calls.length;
    await act(async () => { removal.reject(new Error("NATIVE_CHROME_ACK_UNCERTAIN")); });
    expect(bridge.retire).toHaveBeenCalledTimes(beforeFailure);
    expect(within(waiting.container).getByRole("button", { hidden: true })).not.toBeVisible();
    expect(hasOutstandingNativeChrome(latestControl.controlId)).toBe(true);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...latestControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledTimes(2));
    expect(oldAction).not.toHaveBeenCalled();
    waiting.unmount();
    latestView.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(latestControl.controlId)).toBe(false));

    // An active predecessor can fail without any same-instance rerender.
    const preparation = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValueOnce(preparation.promise);
    const preparations = bridge.prepare.mock.calls.length;
    const pending = render(retainedControl(kind, "pending-preparation", oldAction));
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledTimes(preparations + 1));
    const succeeding = render(retainedControl(kind, "successful-preparation", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(5));
    const successfulControl = bridge.prepare.mock.calls.at(-1)![0];
    const beforeRejection = bridge.retire.mock.calls.length;
    await act(async () => preparation.reject(new Error("NATIVE_CHROME_ACK_UNCERTAIN")));
    expect(bridge.retire).toHaveBeenCalledTimes(beforeRejection);
    expect(within(pending.container).getByRole("button", { hidden: true })).not.toBeVisible();
    expect(hasOutstandingNativeChrome(successfulControl.controlId)).toBe(true);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...successfulControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledTimes(3));
    expect(oldAction).not.toHaveBeenCalled();
    pending.unmount();
    succeeding.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(successfulControl.controlId)).toBe(false));

    // Successful, delayed retirement also cannot give an older mount a fresh
    // revision over a control that won the slot while it was waiting.
    const acknowledgedRemoval = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(acknowledgedRemoval.promise);
    const beforeWaiting = bridge.retire.mock.calls.length;
    const waitingForAck = render(retainedControl(kind, "waiting-ack", oldAction));
    await waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(beforeWaiting + 1));
    const oldRemoval = bridge.retire.mock.calls.at(-1)![0];
    const winner = render(retainedControl(kind, "won-during-ack", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(6));
    const winningControl = bridge.prepare.mock.calls.at(-1)![0];
    const preparedBeforeAck = bridge.prepare.mock.calls.length;
    await act(async () => acknowledgedRemoval.resolve({ ...oldRemoval, phase: "retired" }));
    expect(bridge.prepare).toHaveBeenCalledTimes(preparedBeforeAck);
    expect(within(waitingForAck.container).getByRole("button", { hidden: true })).not.toBeVisible();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...winningControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledTimes(4));
    expect(oldAction).not.toHaveBeenCalled();
    waitingForAck.unmount();
    winner.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(winningControl.controlId)).toBe(false));
  });

  it.each(["back", "history"] as const)("cannot retire a newer %s after an older handoff fails late", async (kind) => {
    measureSlot();
    const replacement = admitReplacement(kind);
    const action = vi.fn();
    const view = render(retainedControl(kind, "original", action));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const oldHandoff = deferred<ChromeAcknowledgement>();
    replacement.mockReturnValueOnce(oldHandoff.promise);
    view.rerender(retainedControl(kind, "replacement", action));
    await waitFor(() => expect(replacement).toHaveBeenCalledOnce());
    // A prepared, unacknowledged predecessor is not eligible for retention.
    view.rerender(retainedControl(kind, "latest", action));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const latest = bridge.prepare.mock.calls.at(-1)![0];
    const retirements = bridge.retire.mock.calls.length;
    await act(async () => oldHandoff.reject(new Error("NATIVE_CHROME_ACK_UNCERTAIN")));
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...latest, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
  });

  it.each(["back", "history", "profile-back"] as const)("never hands off %s across owner, suppression, native invalidation or geometry changes", async (kind) => {
    measureSlot();
    const replacement = admitReplacement(kind, true);
    // Model the native monotonic admission fence, not unconditional bridge
    // success. Reserving a preparation before retirement fails this journey.
    let tombstone = 0;
    let physicallyRemoved = false;
    bridge.retire.mockImplementation(async (value) => {
      tombstone = Math.max(tombstone, value.revision);
      return { ...value, phase: "retired" };
    });
    bridge.prepare.mockImplementation(async (value) => {
      if (value.revision <= tombstone) throw new Error("NATIVE_CHROME_PREPARE_REFUSED");
      tombstone = value.revision;
      physicallyRemoved = false;
      return { ...value, phase: "prepared" };
    });
    bridge.suspend.mockImplementation(async value => {
      if (physicallyRemoved) throw new Error("NATIVE_CHROME_SUSPEND_REFUSED");
      return { ...value, phase: "suspended" };
    });
    const view = render(retainedControl(kind, "original"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    view.rerender(retainedControl(kind, "owner-replaced", undefined, "other-owner"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    view.rerender(retainedControl(kind, "owner-replaced", undefined, "other-owner", true));
    await waitFor(() => expect(view.getByRole("button")).toBeVisible());
    view.rerender(retainedControl(kind, "owner-replaced", undefined, "other-owner"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(3));
    // Native invalidation has already removed the host. A local retained
    // reference must not try to suspend/resume that absent installation.
    const removed = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(removed.promise);
    const preparedBeforeInvalidation = bridge.prepare.mock.calls.length;
    const oldBinding = bridge.prepare.mock.calls.at(-1)![0];
    physicallyRemoved = true;
    act(() => {
      privacy.callbacks.forEach(callback => callback({ generation: 1, shielded: false, appIsActive: true }));
      bridge.callbacks.get("invalidated")?.(undefined);
      bridge.callbacks.get("choiceRequested")?.({ ...oldBinding, sequence: 1, privacyGeneration: 0 });
    });
    await waitFor(() => expect(bridge.retire.mock.results.at(-1)?.value).toBe(removed.promise));
    expect(bridge.prepare).toHaveBeenCalledTimes(preparedBeforeInvalidation);
    expect(bridge.confirmChoice).not.toHaveBeenCalled();
    const retirement = bridge.retire.mock.calls.at(-1)![0];
    await act(async () => removed.resolve({ ...retirement, phase: "retired" }));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(4));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 3, y: 60, width: 44, height: 44, top: 60, left: 3, right: 47, bottom: 104, toJSON: () => ({}),
    });
    view.rerender(retainedControl(kind, "moved", undefined, "other-owner"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(5));
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each(["back", "history"] as const)("retains an admitted %s lease on unchanged geometry, not on geometry or authority changes", async (kind) => {
    admitChat();
    let x = 2;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x, y: 60, width: 44, height: 44, top: 60, left: x, right: x + 44, bottom: 104, toJSON: () => ({}),
    }));
    const action = vi.fn();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const renderControl = (context: string) => kind === "back"
      ? <Harness context={context} onBack={action} /> : <ChatHarness context={context} onAction={action} />;
    const view = render(renderControl("original"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    const retirements = bridge.retire.mock.calls.length;
    fireEvent(window, new Event("resize"));
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.prepare).toHaveBeenCalledOnce();
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    const initial = bridge.prepare.mock.calls[0][0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...initial, sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    x = 3; // A real one-pixel move still invalidates immediately.
    fireEvent(window, new Event("resize"));
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...initial, sequence: 2, privacyGeneration: 0 }));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    expect(action).toHaveBeenCalledOnce();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(window.innerWidth - 1);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(3));
    act(() => bridge.callbacks.get("invalidated")?.(undefined)); // Same coordinates, invalid native authority.
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(4));
    view.rerender(renderControl("replacement")); // Same coordinates, new route/action context.
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(5));
  });

  it("binds Profile Back to its layer and rejects pending or old-stack choices beneath a newer overlay", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back", "profile-back", "close"], independentControls: true });
    const back = vi.fn();
    function ProfileBackHarness({ blocked = false, context = "account" }: { blocked?: boolean; context?: string }) {
      useNativeNavigationBlocked(true, "profile-pane");
      useNativeNavigationBlocked(blocked);
      const focusRef = useRef<HTMLButtonElement>(null);
      return <NativeChatChrome kind="profile-back" label="Back in Profile" owner="owner-a" context={context}
        eligible focusRef={focusRef} className="profile-back-slot" onActivate={back}>
        <button ref={focusRef}>Back in Profile</button>
      </NativeChatChrome>;
    }
    const view = render(<ProfileBackHarness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const old = bridge.prepare.mock.calls[0][0];
    expect(old.controlId).toBe("profile-back");
    // Close and route Back must not route a choice to the Profile stack.
    for (const controlId of ["profile-close", "top-shell-back"]) {
      act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, controlId, sequence: 1, privacyGeneration: 0 }));
    }
    expect(bridge.confirmChoice).not.toHaveBeenCalled();
    const approval = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(approval.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(bridge.confirmChoice).toHaveBeenCalledOnce());
    view.rerender(<ProfileBackHarness blocked />);
    await act(async () => approval.resolve({ valid: true }));
    expect(back).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByRole("button", { name: "Back in Profile" })).toBeVisible());
    view.rerender(<ProfileBackHarness context="security" />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 2, privacyGeneration: 0 }));
    expect(bridge.confirmChoice).toHaveBeenCalledOnce();
    const current = bridge.prepare.mock.calls.at(-1)![0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...current, sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(back).toHaveBeenCalledOnce());
  });
  it("prepares coherent detail Back while covered without granting actions or replacing it on uncover", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back"], independentControls: true,
      coherentPresentation: true, retainedControls: true, inPlaceUpdates: true });
    const back = vi.fn();
    function Destination({ covered }: { covered: boolean }) {
      useNativeNavigationBlocked(covered);
      const focusRef = useRef<HTMLButtonElement>(null);
      return <NativeChatChrome kind="profile-back" label="Back in Profile" owner="owner-a" context="account"
        eligible focusRef={focusRef} className="profile-back-slot" onActivate={back}>
        <button ref={focusRef}>Back in Profile</button>
      </NativeChatChrome>;
    }
    const view = render(<Destination covered />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    await waitFor(() => expect(bridge.update.mock.calls.at(-1)?.[0].enabled).toBe(false));
    const projection = bridge.prepare.mock.calls[0][0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...projection, sequence: 1, privacyGeneration: 0 }));
    expect(bridge.confirmChoice).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "Back in Profile" })).toBeNull();
    const retirements = bridge.retire.mock.calls.length;
    view.rerender(<Destination covered={false} />);
    await waitFor(() => expect(bridge.update.mock.calls.at(-1)?.[0].enabled).toBe(true));
    expect(bridge.prepare).toHaveBeenCalledOnce();
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
  });
  it("admits a covered feature page without modal autofocus capturing its web Back", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back"], independentControls: true,
      coherentPresentation: true, retainedControls: true, inPlaceUpdates: true });
    const ready = vi.fn();
    function CoveredDestination() {
      useNativeNavigationBlocked(true);
      return <NativeFeaturePage open title="Preferences" owner="owner-a" context="preferences" onBack={vi.fn()} onReady={ready}>
        <p>Public preference choices</p>
      </NativeFeaturePage>;
    }
    render(<CoveredDestination />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(document.activeElement?.closest("[data-native-chrome-slot]")).toBeNull();
    expect(bridge.update.mock.calls.at(-1)?.[0].enabled).toBe(false);
  });
  it("keeps the established pane Back actionable when owned native panes are unsupported", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back", "close"], independentControls: true,
      coherentPresentation: true, retainedControls: true, inPlaceUpdates: true });
    const back = vi.fn();
    const view = render(<NativeFeaturePage pane open title="Preferences" owner="owner-a" context="legacy-pane" onBack={back}>
      <p>Established preferences</p>
    </NativeFeaturePage>);
    await waitFor(() => expect(view.getByRole("button", { name: "Back in Profile" })).toBeEnabled());
    fireEvent.click(view.getByRole("button", { name: "Back in Profile" }));
    expect(back).toHaveBeenCalledOnce();
    expect(bridge.acquireContentPane).not.toHaveBeenCalled();
    expect(bridge.prepare).not.toHaveBeenCalled();
    view.unmount();
  });
  it("reveals a full-height Profile pane only after its plane and both header controls are acknowledged", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back", "close"], independentControls: true,
      coherentPresentation: true, ownedContentPane: true, retainedControls: true, inPlaceUpdates: true });
    let admit: ((receipt: unknown) => void) | undefined;
    bridge.acquireContentPane.mockImplementation(() => new Promise(resolve => { admit = resolve; }));
    bridge.releaseContentPane.mockImplementation(async identity => ({ ...identity, phase: "retired" }));
    const ready = vi.fn(), close = vi.fn();
    const view = render(<NativeFeaturePage pane open title="Preferences" owner="owner-a" context="pane"
      onBack={vi.fn()} onClose={close} onReady={ready}><p>Public preferences</p></NativeFeaturePage>);
    await waitFor(() => expect(bridge.acquireContentPane).toHaveBeenCalledOnce());
    expect(ready).not.toHaveBeenCalled();
    expect(bridge.prepare).not.toHaveBeenCalled();
    const identity = bridge.acquireContentPane.mock.calls[0][0];
    await act(async () => { admit?.({ ...identity, phase: "active" }); });
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(view.getByRole("dialog", { name: "Preferences" })).toBeVisible();
    expect(bridge.prepare.mock.calls.map(([p]) => p.controlId).sort()).toEqual(["profile-back", "profile-close"]);
    expect(bridge.prepare.mock.calls.every(([p]) => p.contentPane.generation === identity.generation)).toBe(true);
    const projection = bridge.prepare.mock.calls.find(([p]) => p.controlId === "profile-close")![0];
    const updateSequence = bridge.update.mock.calls.filter(([p]) => p.controlId === "profile-close").at(-1)?.[0].updateSequence ?? 0;
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...projection, sequence: 1, updateSequence, privacyGeneration: 0 }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    // A negative owner binding cannot invoke Close a second time.
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...projection, ownerEpoch: "retired-owner", sequence: 2, updateSequence, privacyGeneration: 0 }));
    expect(close).toHaveBeenCalledOnce();
    const originalPane = view.getByRole("dialog", { name: "Preferences" });
    bridge.activate.mockImplementation(() => new Promise(() => undefined));
    view.rerender(<NativeFeaturePage pane open title="Voice" owner="owner-a" context="pane:voice"
      onBack={vi.fn()} onClose={close} onReady={ready}><p>Public voice settings</p></NativeFeaturePage>);
    expect(view.getByRole("dialog", { name: "Voice" })).toBe(originalPane);
    expect(originalPane).toBeVisible();
    expect(bridge.acquireContentPane).toHaveBeenCalledOnce();
    expect(bridge.releaseContentPane).not.toHaveBeenCalled();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...projection, sequence: 3, updateSequence, privacyGeneration: 0 }));
    // Close keeps its lifetime binding; only nested Back changes authority.
    await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    view.rerender(<NativeFeaturePage pane open title="Voice" owner="owner-b" context="pane:voice"
      onBack={vi.fn()} onClose={close} onReady={ready}><p>Public voice settings</p></NativeFeaturePage>);
    expect(originalPane).not.toBeVisible();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...projection, sequence: 4, updateSequence, privacyGeneration: 0 }));
    expect(close).toHaveBeenCalledTimes(2);
    view.unmount();
    await waitFor(() => expect(bridge.releaseContentPane).toHaveBeenCalled());
  });
  it("keeps Account and bounded settings navigation inside one native Profile lifetime without a DOM handoff", async () => {
    vi.stubGlobal("__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", { contractVersion: 1, enabled: true, coherentShell: true });
    publishValidatedAuthSessionOwner("owner-a");
    privacy.state = { generation: 0, shielded: false, appIsActive: true, cause: "inactive" };
    const groups = profileMenuGroups(false);
    const actions = Object.fromEntries(groups.flatMap(group => group.entries.map(entry => [entry.id, vi.fn()]))) as ProfileMenuActions;
    drawerBridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true, wholePresentation: true,
      profileMenuRows: true, profileContentHandoff: true, profileNavigationStack: true, profileSettingsPages: true, profileVoiceSettings: true, profileTrustedDevices: true, profileAccountActions: true, profileLegalReader: true, profileStyleScene: true, profileNameScene: true, profileReferralPages: true, profileSupportScene: true, profilePhoneScene: true, presentationCompletion: true,
      generation: 0, isolated: false });
    drawerBridge.getPresentationState.mockImplementation(async () => ({ ...drawerBridge.apply.mock.calls.at(-1)![0],
      valid: true, settled: true, phase: "active" }));
    drawerBridge.apply.mockReset().mockImplementation(async state => ({ ...state, phase: "active" }));
    drawerBridge.confirmChoice.mockReset().mockResolvedValue({ valid: true });
    drawerBridge.retire.mockImplementation(async identity => ({ ...identity, phase: "retired",
      updateSequence: drawerBridge.apply.mock.calls.at(-1)?.[0].updateSequence ?? 0, privacyGeneration: 0 }));
    const confirmAccount = vi.fn(), cancelAccount = vi.fn(), confirmDevice = vi.fn();
    const scene = (account: boolean, settings?: "preferences" | "voice" | "security" | "session" | "devices" | "device-unlink", support = false, legal?: "privacy" | "terms", confirmation?: "account-reset" | "account-delete", phone = false, referrals = false) => <NativeProfilePresentation lifetime="same-owner-vault" detail={account || !!settings || support || !!legal || referrals}
      menu={{ owner: "owner-a", ready: true, open: true, surfaceOpen: true, name: "Public sample", email: null, groups, actions, onClose: vi.fn() }}
      page={{ pane: true, title: "Your account", owner: "owner-a", context: account ? "account" : "root", onBack: vi.fn() }}
      settings={{ active: !!settings, requiresVoice: settings === "voice", requiresDevices: settings === "devices" || settings === "device-unlink", pages: settings === "devices" || settings === "device-unlink" ? [
        { id: "security", title: "Security", sections: [] },
        { id: "devices", title: "Trusted devices", sections: [] },
        ...(settings === "device-unlink" ? [{ id: "device-unlink" as const, title: "Test computer", sections: [{ id: "device-confirmation", rows: [
          { id: "device-submit", label: "Unlink device", enabled: true, destructive: true },
        ] }] }] : []),
      ] : settings === "preferences" || settings === "voice" ? [{ id: "preferences", title: "Preferences", sections: [{ id: "appearance-choices", rows: [
        { id: "theme-choice", label: "Appearance", enabled: true, options: [
          { id: "pick-light", label: "Light", selected: true }, { id: "pick-dark", label: "Dark", selected: false },
        ] },
      ] }] }, ...(settings === "voice" ? [{ id: "voice" as const, title: "Voice", sections: [{ id: "voice-controls", rows: [
        { id: "voice-enabled", label: "Voice control", enabled: true, toggle: true, options: [
          { id: "voice-on", label: "On", selected: true }, { id: "voice-off", label: "Off", selected: false },
        ] },
      ] }] }] : [])] : [{ id: "security", title: "Security", sections: [] }, ...(settings === "session" ? [{ id: "session" as const, title: "Account access", sections: [] }] : [])],
        rows: new Map([["pick-light", vi.fn()], ["pick-dark", vi.fn()], ["voice-on", vi.fn()], ["voice-off", vi.fn()], ["device-submit", confirmDevice]]), root: vi.fn(), ancestor: vi.fn() }}
      support={{ active: support, editor: destination => <p data-testid="public-support-sheet">{destination}</p> }}
      phone={{ active: phone, editor: options => options.native && options.destinationId ? <p data-testid="public-phone-sheet">{options.destinationId}</p> : null }}
      legal={{ active: !!legal, ...projectNativeProfileLegal(legal ?? null, vi.fn(), vi.fn()), root: vi.fn() }}
      referrals={{ active: referrals, pages: [{ id: "referrals", title: "Invite friends", sections: [{ id: "referrals-synthetic", rows: [
        { id: "referral-copy", label: "Copy", enabled: true },
        { id: "referral-progress", label: "Next reward", enabled: true, readOnly: true, progress: { value: 2, total: 5 } },
      ] }] }], rows: new Map([["referral-copy", vi.fn()]]), root: vi.fn(), editor: () => null }}
      account={{ active: account, page: { id: "account", title: "Your account", sections: [{ id: "account-portrait", rows: [
        { id: "account-photo", label: "Public sample", detail: "sample@example.test", enabled: true, portrait: true },
      ] }, { id: "account-info", rows: [
        { id: "edit-name", label: "Display name", enabled: true },
        { id: "account-mail", label: "Mail", detail: "sample@example.test", enabled: true, readOnly: true },
      ] }] }, ...(confirmation ? { confirmation: { id: confirmation, title: "Confirm account action", sections: [{ id: "account-confirmation", rows: [
        { id: "account-confirmation-submit", label: "Confirm", enabled: true, destructive: true },
        { id: "account-confirmation-cancel", label: "Cancel", enabled: true },
      ] }] }, back: cancelAccount } : {}), rows: new Map([["account-photo", vi.fn()], ["edit-name", vi.fn()], ["account-confirmation-submit", confirmAccount], ["account-confirmation-cancel", cancelAccount]]), editor: () => null }}>
      <p>React account exception</p>
    </NativeProfilePresentation>;
    const view = render(scene(false));
    try {
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack).toEqual([]));
      const identity = drawerBridge.apply.mock.calls.at(-1)![0];
      view.rerender(scene(false, undefined, false, undefined, undefined, false, true));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.[0]?.id).toBe("referrals"));
      const invite = drawerBridge.apply.mock.calls.at(-1)![0];
      expect(invite.revision).toBe(identity.revision);
      expect(validNativeDrawerProjection(invite)).toBe(true);
      expect(validNativeDrawerProjection({ ...invite, profileStack: [{ ...invite.profileStack![0], sections: [{ id: "invalid-progress", rows: [
        { id: "invalid-row", label: "Invalid", enabled: true, readOnly: true, progress: { value: 6, total: 5 } },
      ] }] }] })).toBe(false);
      expect(screen.queryByText("React account exception")).not.toBeInTheDocument();
      view.rerender(scene(true));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.[0]?.id).toBe("account"));
      const firstVisit = drawerBridge.apply.mock.calls.at(-1)![0];
      expect(firstVisit.profileStack?.[0].sections[0].rows[0]).toEqual({
        id: "account-photo", label: "Profile photo", enabled: true, artworkId: "account", chevron: true,
      });
      expect(firstVisit.profileStack?.[0].sections[1].rows[1].detail).toBe("sample@example.test");
      expect(firstVisit.revision).toBe(identity.revision);
      expect(view.queryByText("React account exception")).toBeNull();
      expect(bridge.acquireContentPane).not.toHaveBeenCalled();
      expect(drawerBridge.apply.mock.calls.every(([state]) => state.open)).toBe(true);
      view.rerender(scene(false));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack).toEqual([]));
      view.rerender(scene(true));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileDestinationId).not.toBe(firstVisit.profileDestinationId));
      expect(drawerBridge.apply.mock.calls.at(-1)![0].revision).toBe(identity.revision);
      view.rerender(scene(true, undefined, false, undefined, "account-delete"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.map(page => page.id)).toEqual(["account", "account-delete"]));
      const confirmation = drawerBridge.apply.mock.calls.at(-1)![0];
      expect(validNativeDrawerProjection(confirmation)).toBe(true);
      const wrongParent = structuredClone(confirmation);
      wrongParent.profileStack![0].id = "preferences";
      expect(validNativeDrawerProjection(wrongParent)).toBe(false);
      const cancelChoice = { ...confirmation, action: "row", rowId: "account-confirmation-cancel", sequence: 1, interactionGeneration: 1 };
      act(() => drawerBridge.listeners.get("choice")?.forEach(callback => callback(cancelChoice)));
      await waitFor(() => expect(cancelAccount).toHaveBeenCalledOnce());
      act(() => drawerBridge.listeners.get("choice")?.forEach(callback => callback(cancelChoice)));
      expect(cancelAccount).toHaveBeenCalledOnce();
      view.rerender(scene(true));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.map(page => page.id)).toEqual(["account"]));
      act(() => drawerBridge.listeners.get("choice")?.forEach(callback => callback({ ...cancelChoice, sequence: 2, rowId: "account-confirmation-submit" })));
      await act(async () => { await Promise.resolve(); });
      expect(confirmAccount).not.toHaveBeenCalled();
      view.rerender(scene(true, undefined, false, undefined, "account-reset"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.at(-1)?.id).toBe("account-reset"));
      const reset = { ...drawerBridge.apply.mock.calls.at(-1)![0], action: "row", rowId: "account-confirmation-submit", sequence: 3, interactionGeneration: 1 };
      act(() => drawerBridge.listeners.get("choice")?.forEach(callback => callback(reset)));
      await waitFor(() => expect(confirmAccount).toHaveBeenCalledOnce());
      act(() => drawerBridge.listeners.get("choice")?.forEach(callback => callback(reset)));
      expect(confirmAccount).toHaveBeenCalledOnce();
      expect(bridge.acquireContentPane).not.toHaveBeenCalled();
      expect(drawerBridge.retire).not.toHaveBeenCalled();
      view.rerender(scene(false, "preferences"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.[0]?.id).toBe("preferences"));
      const preferences = drawerBridge.apply.mock.calls.at(-1)![0];
      expect(preferences.profileDestinationId).not.toBe(firstVisit.profileDestinationId);
      expect(validNativeDrawerProjection(preferences)).toBe(true);
      const selection = { ...preferences, action: "row" as const, rowId: "pick-dark", sequence: 1, interactionGeneration: 1 };
      expect(nativeDrawerChoiceAllowed(selection, preferences)).toBe(true);
      expect(nativeDrawerChoiceAllowed({ ...selection, rowId: "pick-light" }, preferences)).toBe(false);
      expect(nativeDrawerChoiceAllowed({ ...selection, action: "root", rowId: undefined }, preferences)).toBe(false);
      const duplicateChoices = structuredClone(preferences);
      duplicateChoices.profileStack![0].sections[0].rows[0].options![1].id = "pick-light";
      expect(validNativeDrawerProjection(duplicateChoices)).toBe(false);
      view.rerender(scene(false, "voice"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.map(page => page.id)).toEqual(["preferences", "voice"]));
      const voice = drawerBridge.apply.mock.calls.at(-1)![0];
      expect(validNativeDrawerProjection(voice)).toBe(true);
      expect(nativeDrawerChoiceAllowed({ ...selection, ...voice, rowId: "voice-off" }, voice)).toBe(true);
      const unrelatedVoiceParent = structuredClone(voice);
      unrelatedVoiceParent.profileStack![0].id = "security";
      expect(validNativeDrawerProjection(unrelatedVoiceParent)).toBe(false);
      const rootVoice = structuredClone(voice);
      rootVoice.profileStack = rootVoice.profileStack!.slice(1);
      expect(validNativeDrawerProjection(rootVoice)).toBe(true);
      view.rerender(scene(false, "session"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.map(page => page.id)).toEqual(["security", "session"]));
      const nested = drawerBridge.apply.mock.calls.at(-1)![0];
      expect(nativeDrawerChoiceAllowed({ ...selection, ...nested, action: "root", rowId: undefined }, nested)).toBe(true);
      view.rerender(scene(false, "device-unlink"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.map(page => page.id)).toEqual(["security", "devices", "device-unlink"]));
      const unlink = drawerBridge.apply.mock.calls.at(-1)![0];
      expect(validNativeDrawerProjection(unlink)).toBe(true);
      expect(nativeDrawerChoiceAllowed({ ...selection, ...unlink, action: "ancestor", rowId: "security" }, unlink)).toBe(true);
      expect(nativeDrawerChoiceAllowed({ ...selection, ...unlink, action: "ancestor", rowId: "account" }, unlink)).toBe(false);
      const directDeviceEntry = structuredClone(unlink);
      directDeviceEntry.profileStack = directDeviceEntry.profileStack!.slice(1);
      expect(validNativeDrawerProjection(directDeviceEntry)).toBe(true);
      expect(nativeDrawerChoiceAllowed({ ...selection, ...directDeviceEntry, action: "ancestor", rowId: "security" }, directDeviceEntry)).toBe(false);
      const wrongDeviceParent = structuredClone(unlink);
      wrongDeviceParent.profileStack![1].id = "session";
      expect(validNativeDrawerProjection(wrongDeviceParent)).toBe(false);
      view.rerender(scene(false, "devices"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.map(page => page.id)).toEqual(["security", "devices"]));
      expect(nativeDrawerChoiceAllowed({ ...selection, ...unlink, rowId: "device-submit" }, drawerBridge.apply.mock.calls.at(-1)![0])).toBe(false);
      view.rerender(scene(false, "security"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.map(page => page.id)).toEqual(["security"]));
      view.rerender(scene(false, "preferences"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.[0]?.id).toBe("preferences"));
      expect(drawerBridge.apply.mock.calls.at(-1)![0].profileDestinationId).not.toBe(preferences.profileDestinationId);
      expect(drawerBridge.apply.mock.calls.at(-1)![0].revision).toBe(identity.revision);
      expect(view.queryByText("React account exception")).toBeNull();
      expect(bridge.acquireContentPane).not.toHaveBeenCalled();
      expect(drawerBridge.retire).not.toHaveBeenCalled();
      view.rerender(scene(false, undefined, true));
      await waitFor(() => expect(view.getByTestId("public-support-sheet")).toBeInTheDocument());
      const support = drawerBridge.apply.mock.calls.at(-1)![0];
      expect(support.profileStack).toEqual([]); // Keep the meaningful root; never push a blank Support page.
      expect(support.profileDestinationId).toBeUndefined();
      expect(support.profileSupportDestinationId).toBeTruthy();
      expect(validNativeDrawerProjection(support)).toBe(true);
      expect(validNativeDrawerProjection({ ...support, family: "history" })).toBe(false);
      expect(support.revision).toBe(identity.revision);
      expect(bridge.acquireContentPane).not.toHaveBeenCalled();
      expect(drawerBridge.retire).not.toHaveBeenCalled();
      view.rerender(scene(false, undefined, false, "privacy"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.map(page => page.id)).toEqual(["legal", "privacy"]));
      const legalVisit = drawerBridge.apply.mock.calls.at(-1)![0];
      view.rerender(scene(false, undefined, false, "terms"));
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.map(page => page.id)).toEqual(["legal", "terms"]));
      expect(drawerBridge.apply.mock.calls.at(-1)![0].profileDestinationId).not.toBe(legalVisit.profileDestinationId);
      expect(drawerBridge.apply.mock.calls.at(-1)![0].revision).toBe(identity.revision);
      expect(view.queryByText("React account exception")).toBeNull();
      expect(bridge.acquireContentPane).not.toHaveBeenCalled();
      expect(drawerBridge.retire).not.toHaveBeenCalled();
      view.rerender(scene(true, undefined, false, undefined, undefined, true));
      await waitFor(() => expect(view.getByTestId("public-phone-sheet")).toBeInTheDocument());
      let finishParent!: (state: unknown) => void;
      const parentReadmission = new Promise(resolve => { finishParent = resolve; });
      drawerBridge.getPresentationState.mockImplementation(async () => parentReadmission);
      act(() => {
        privacy.state = { ...privacy.state, generation: 1 };
        privacy.observations.forEach(listener => listener());
      });
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].privacyGeneration).toBe(1));
      expect(view.queryByTestId("public-phone-sheet")).toBeNull();
      await act(async () => { finishParent({ ...drawerBridge.apply.mock.calls.at(-1)![0], valid: true, settled: true, phase: "active" }); });
      await waitFor(() => expect(view.getByTestId("public-phone-sheet")).toBeInTheDocument());
      drawerBridge.getPresentationState.mockImplementation(async () => ({ ...drawerBridge.apply.mock.calls.at(-1)![0], valid: true, settled: true, phase: "active" }));
      view.unmount();
      privacy.state = { ...privacy.state, generation: 0 };
      await act(async () => { await Promise.resolve(); });
      for (const target of ["account", "preferences", "support"] as const) {
        const method = target === "account" ? "settleProfileNameAction" :
          target === "preferences" ? "retireProfileStyleScene" : "confirmProfileSupportAction";
        const complete = nativeDrawers()[method];
        Reflect.deleteProperty(nativeDrawers(), method);
        drawerBridge.apply.mockClear();
        const partial = render(scene(target === "account", target === "preferences" ? "preferences" : undefined, target === "support"));
        try {
          // A claimed scene without its full handshake keeps the coherent page.
          // Do not enter a destination whose editor cannot settle or withdraw.
          await waitFor(() => expect(partial.getByText("React account exception")).toBeVisible());
          expect(drawerBridge.apply.mock.calls.some(([state]) => target === "support" ? state.profileSupportDestinationId !== undefined :
            state.profileStack?.some(page => page.id === target))).toBe(false);
        } finally {
          partial.unmount();
          Object.assign(nativeDrawers(), { [method]: complete });
          await act(async () => { await Promise.resolve(); });
        }
      }
      const capability = await drawerBridge.getCapabilities();
      drawerBridge.getCapabilities.mockResolvedValue({ ...capability, profilePortrait: true });
      const supportedPortrait = render(scene(true));
      try {
        await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].profileStack?.[0].sections[0].rows[0].portrait).toBe(true));
        expect(drawerBridge.apply.mock.calls.at(-1)![0].profileStack?.[0].sections[0].rows[0].detail).toBe("sample@example.test");
      } finally {
        supportedPortrait.unmount(); drawerBridge.getCapabilities.mockResolvedValue(capability);
        await act(async () => { await Promise.resolve(); });
      }
      drawerBridge.getCapabilities.mockResolvedValue({ ...capability, profileTrustedDevices: false });
      drawerBridge.apply.mockClear();
      const legacyDevices = render(scene(false, "devices"));
      try {
        await waitFor(() => expect(legacyDevices.getByText("React account exception")).toBeVisible());
        expect(drawerBridge.apply.mock.calls.some(([state]) => state.profileStack?.some(page => page.id === "devices"))).toBe(false);
      } finally {
        legacyDevices.unmount(); drawerBridge.getCapabilities.mockResolvedValue(capability);
        await act(async () => { await Promise.resolve(); });
      }
      drawerBridge.getCapabilities.mockResolvedValue({ ...capability, profileAccountActions: false });
      drawerBridge.apply.mockClear();
      const legacyConfirmation = render(scene(true, undefined, false, undefined, "account-delete"));
      try {
        await waitFor(() => expect(legacyConfirmation.getByText("React account exception")).toBeVisible());
        expect(drawerBridge.apply.mock.calls.some(([state]) => state.profileStack?.some(page => page.id === "account-delete"))).toBe(false);
      } finally {
        legacyConfirmation.unmount(); drawerBridge.getCapabilities.mockResolvedValue(capability);
        await act(async () => { await Promise.resolve(); });
      }
      drawerBridge.getCapabilities.mockResolvedValue({ ...capability, profileVoiceSettings: false });
      drawerBridge.apply.mockClear();
      const legacyVoice = render(scene(false, "voice"));
      try {
        await waitFor(() => expect(legacyVoice.getByText("React account exception")).toBeVisible());
        expect(drawerBridge.apply.mock.calls.some(([state]) => state.profileStack?.some(page => page.id === "voice"))).toBe(false);
      } finally {
        legacyVoice.unmount(); drawerBridge.getCapabilities.mockResolvedValue(capability);
        await act(async () => { await Promise.resolve(); });
      }
      drawerBridge.getCapabilities.mockResolvedValue({ ...capability, profileLegalReader: false });
      drawerBridge.apply.mockClear();
      const legacyLegal = render(scene(false, undefined, false, "privacy"));
      try {
        await waitFor(() => expect(legacyLegal.getByText("React account exception")).toBeVisible());
        expect(drawerBridge.apply.mock.calls.some(([state]) => state.profileStack?.some(page => page.id === "legal"))).toBe(false);
      } finally {
        legacyLegal.unmount(); drawerBridge.getCapabilities.mockResolvedValue(capability);
        await act(async () => { await Promise.resolve(); });
      }
    } finally {
      view.unmount(); await act(async () => { await Promise.resolve(); }); publishValidatedAuthSessionOwner(null);
    }
  });

  it.each(["completed", "retired", "retired-before-parent", "uncertain"] as const)("admits a Profile detail modal only after its parent and %s menu disappearance", async outcome => {
    measureSlot();
    vi.stubGlobal("__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", { contractVersion: 1, enabled: true, coherentShell: true });
    publishValidatedAuthSessionOwner("owner-a");
    privacy.state = { generation: 0, shielded: false, appIsActive: true, cause: "inactive" };
    drawerBridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true, wholePresentation: true,
      profileMenuRows: true, profileContentHandoff: true, presentationCompletion: true, generation: 0, isolated: false });
    let closed: NativeDrawerProjection | undefined;
    let returning: NativeDrawerProjection | undefined, holdReturn = false, retirementReadback = false;
    const returnGate = deferred<unknown>();
    drawerBridge.apply.mockReset().mockImplementation(async state => {
      if (state.open && holdReturn) { returning = state; return returnGate.promise; }
      if (state.open && outcome === "retired-before-parent") throw new Error("synthetic-early-retirement");
      if (!state.open) {
        closed = state;
        if (outcome !== "completed") throw new Error("synthetic-hide-uncertainty");
      }
      return { ...state, phase: "active" };
    });
    drawerBridge.getPresentationState.mockImplementation(async () => {
      const state = drawerBridge.apply.mock.calls.at(-1)![0];
      if (!state.open) { closed = state; retirementReadback = true; }
      return { ...state, phase: "active", valid: true, settled: state.open };
    });
    drawerBridge.retire.mockImplementation(async identity => {
      if (outcome === "uncertain") throw new Error("synthetic-retirement-uncertainty");
      return { ...identity, phase: "retired", updateSequence: drawerBridge.apply.mock.calls.at(-1)![0].updateSequence, privacyGeneration: 0 };
    });
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back", "close"], independentControls: true,
      coherentPresentation: true, ownedContentPane: true, retainedControls: true, inPlaceUpdates: true });
    const acquisition = deferred<Awaited<ReturnType<typeof bridge.acquireContentPane>>>();
    let parent: Parameters<typeof bridge.acquireContentPane>[0] | undefined;
    bridge.acquireContentPane.mockImplementation(async identity => { parent = identity; return acquisition.promise; });
    bridge.releaseContentPane.mockImplementation(async identity => ({ ...identity, phase: "retired" }));
    const groups = profileMenuGroups(false);
    const actions = Object.fromEntries(groups.flatMap(group => group.entries.map(entry => [entry.id, vi.fn()]))) as ProfileMenuActions;
    function PhotoModal() {
      // A photo sheet cannot appear until its whole parent paint plane is
      // admitted and the outgoing native menu actually disappears.
      useNativeNavigationBlocked(true);
      return <button>Public photo preview</button>;
    }
    const scene = (detail: boolean, lifetime = "owner-a:vault-a") => <NativeProfilePresentation lifetime={lifetime} detail={detail}
      menu={{ owner: "owner-a", ready: true, open: true, surfaceOpen: true, name: "Public sample", email: null, groups, actions, onClose: vi.fn() }}
      page={{ pane: true, title: "Your account", owner: "owner-a", context: detail ? "account-photo" : "root", onBack: vi.fn(), onClose: vi.fn() }}
      detailOverlay={<PhotoModal />}><p>Public Account content</p></NativeProfilePresentation>;
    const view = render(scene(true));
    await waitFor(() => expect(parent).toBeDefined());
    expect(bridge.prepare.mock.calls.some(([state]) => state.controlId === "profile-back")).toBe(false);
    expect(view.queryByText("Public photo preview")).toBeNull();
    if (outcome === "retired-before-parent") await waitFor(() => expect(drawerBridge.retire).toHaveBeenCalledOnce());
    await act(async () => acquisition.resolve({ ...parent!, phase: "active" }));
    if (outcome === "retired-before-parent") {
      await waitFor(() => expect(view.getByText("Public photo preview")).toBeVisible());
      expect(drawerBridge.apply.mock.calls.every(([state]) => state.open)).toBe(true);
      view.unmount();
      await act(async () => { await Promise.resolve(); });
      return;
    }
    await waitFor(() => expect(closed).toBeDefined());
    if (outcome !== "completed") {
      await waitFor(() => expect(drawerBridge.retire).toHaveBeenCalledOnce());
      if (outcome === "retired") await waitFor(() => expect(view.getByText("Public photo preview")).toBeVisible());
      else {
        await waitFor(() => expect(retirementReadback).toBe(true));
        expect(view.queryByText("Public photo preview")).toBeNull();
      }
      view.unmount();
      await act(async () => { await Promise.resolve(); });
      return;
    }
    expect(view.queryByText("Public photo preview")).toBeNull();
    const firstClosed = closed!;
    const complete = (state: NativeDrawerProjection) => act(() => {
      drawerBridge.listeners.get("presentationSettled")?.forEach(listener => listener({ ...state, phase: "active", valid: true, settled: true }));
    });
    complete(firstClosed);
    await waitFor(() => expect(view.getByText("Public photo preview")).toBeVisible());
    holdReturn = true;
    view.rerender(scene(false));
    expect(view.queryByText("Public photo preview")).toBeNull();
    await waitFor(() => expect(returning).toBeDefined());
    // Re-enter the same context while its old content is still painted and
    // root return is pending. A fresh callback closure is not fresh admission.
    view.rerender(scene(true));
    complete(firstClosed);
    expect(view.queryByText("Public photo preview")).toBeNull();
    holdReturn = false;
    await act(async () => returnGate.resolve({ ...returning!, phase: "active" }));
    await waitFor(() => expect(closed?.updateSequence).toBeGreaterThan(firstClosed.updateSequence));
    complete(firstClosed);
    expect(view.queryByText("Public photo preview")).toBeNull();
    complete(closed!);
    await waitFor(() => expect(view.getByText("Public photo preview")).toBeVisible());
    view.rerender(scene(true, "owner-a:vault-b"));
    expect(view.queryByText("Public photo preview")).toBeNull();
    view.unmount();
    await act(async () => { await Promise.resolve(); });
  });

  it.each(["return", "new-detail", "close", "owner"] as const)("retains the outgoing Profile display without stale Back authority during %s handoff", async outcome => {
    measureSlot();
    vi.stubGlobal("__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", { contractVersion: 1, enabled: true, coherentShell: true });
    publishValidatedAuthSessionOwner("owner-a");
    privacy.state = { generation: 0, shielded: false, appIsActive: true, cause: "inactive" };
    drawerBridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true, wholePresentation: true,
      profileMenuRows: true, profileContentHandoff: true, generation: 0, isolated: false });
    const rootAdmission = deferred<unknown>();
    let holdReturn = false;
    let returning: NativeDrawerProjection | undefined;
    drawerBridge.apply.mockReset().mockImplementation(async state => {
      if (state.open && holdReturn) { returning = state; return rootAdmission.promise; }
      return { ...state, phase: "active" };
    });
    drawerBridge.retire.mockImplementation(async identity => {
      const latest = drawerBridge.apply.mock.calls.at(-1)![0];
      return { ...identity, phase: "retired", updateSequence: latest.updateSequence,
        privacyGeneration: latest.privacyGeneration };
    });
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back", "close"], independentControls: true,
      coherentPresentation: true, ownedContentPane: true, retainedControls: true, inPlaceUpdates: true });
    bridge.acquireContentPane.mockImplementation(async identity => ({ ...identity, phase: "active" }));
    bridge.releaseContentPane.mockImplementation(async identity => ({ ...identity, phase: "retired" }));
    const groups = profileMenuGroups(false);
    const actions = Object.fromEntries(groups.flatMap(group => group.entries.map(entry => [entry.id, vi.fn()]))) as ProfileMenuActions;
    const back = vi.fn(), close = vi.fn();
    const scene = (detail: "preferences" | "security" | null, open = true, lifetime = "owner-a:vault-a") => <NativeProfilePresentation lifetime={lifetime} detail={!!detail}
      menu={{ owner: "owner-a", ready: true, open, surfaceOpen: open, name: "Public sample", email: null, groups, actions, onClose: close }}
      page={{ pane: true, title: detail === "preferences" ? "Preferences" : detail === "security" ? "Security" : "Profile",
        owner: "owner-a", context: detail ?? "root", onBack: back, onClose: close }}>
      <p>{detail === "preferences" ? "Public preference controls" : detail === "security" ? "Public security controls" : "Menu destination"}</p>
    </NativeProfilePresentation>;
    const view = render(scene("preferences"));
    await waitFor(() => expect(view.getByRole("dialog", { name: "Preferences" })).toBeVisible());
    await waitFor(() => expect(drawerBridge.apply.mock.calls.some(([state]) => !state.open)).toBe(true));
    const pane = view.getByRole("dialog", { name: "Preferences" });
    holdReturn = true;
    view.rerender(scene(null));
    await waitFor(() => expect(returning).toBeDefined());
    expect(pane).toBeVisible();
    expect(view.getByRole("dialog", { name: "Preferences" })).toBe(pane);
    expect(view.getByText("Public preference controls").closest("[inert]")).not.toBeNull();
    expect(view.queryByText("Menu destination")).toBeNull();
    expect(pane.querySelector('button[aria-label="Back in Profile"]')).toBeDisabled();
    // An obsolete Back (including Escape) cannot pop the already-requested
    // parent again. Close retains the current lifetime callback.
    fireEvent.keyDown(pane, { key: "Escape" });
    expect(back).not.toHaveBeenCalled();
    expect(bridge.releaseContentPane).not.toHaveBeenCalled();
    if (outcome === "new-detail") {
      view.rerender(scene("security"));
      expect(view.getByRole("dialog", { name: "Security" })).toBe(pane);
      expect(view.getByText("Public security controls").closest("[inert]")).toBeNull();
      expect(view.queryByText("Public preference controls")).toBeNull();
    } else if (outcome === "close") {
      view.rerender(scene(null, false));
      await waitFor(() => expect(view.queryByText("Public preference controls")).toBeNull());
    } else if (outcome === "owner") {
      // The owner/vault lease invalidates the private display immediately.
      view.rerender(scene(null, true, "owner-a:vault-b"));
      expect(view.queryByText("Public preference controls")).toBeNull();
    }
    await act(async () => { rootAdmission.resolve({ ...returning!, phase: "active" }); });
    if (outcome === "new-detail") {
      await waitFor(() => expect(drawerBridge.apply.mock.calls.at(-1)?.[0].open).toBe(false));
      expect(view.getByRole("dialog", { name: "Security" })).toBeVisible();
      expect(view.getByText("Public security controls")).toBeVisible();
      expect(bridge.releaseContentPane).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(view.queryByRole("dialog", { name: "Preferences" })).toBeNull());
      await waitFor(() => expect(bridge.releaseContentPane).toHaveBeenCalledOnce());
    }
    view.unmount();
    await act(async () => { await Promise.resolve(); });
  });
  it.each(["current", "owner", "closed"] as const)("settles Profile readiness after an appearance change during activation only for the %s pane", async outcome => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back", "close"], independentControls: true,
      coherentPresentation: true, ownedContentPane: true, retainedControls: true, inPlaceUpdates: true });
    bridge.acquireContentPane.mockImplementation(async identity => ({ ...identity, phase: "active" }));
    bridge.releaseContentPane.mockImplementation(async identity => ({ ...identity, phase: "retired" }));
    const activation = deferred<ChromeAcknowledgement>(), update = deferred<ChromeUpdateAcknowledgement>();
    let held: ChromeProjection | undefined, heldUpdate = false;
    bridge.activate.mockImplementation(async value => {
      if (value.controlId === "profile-back" && !held) { held = value; return activation.promise; }
      return { ...value, phase: "active" };
    });
    bridge.update.mockImplementation(async value => {
      if (value.revision === held?.revision && value.controlId === "profile-back" && value.appearance === "dark" && !heldUpdate) {
        heldUpdate = true; return update.promise;
      }
      return value;
    });
    const ready = vi.fn(), replacementReady = vi.fn(), back = vi.fn(), close = vi.fn();
    function Destination({ owner = "owner-a", open = true }: { owner?: string; open?: boolean }) {
      useNativeNavigationBlocked(true); // Menu remains authoritative during preparation.
      return <NativeFeaturePage pane open={open} title="Preferences" owner={owner} context="pane"
        onBack={back} onClose={close} onReady={owner === "owner-a" ? ready : replacementReady}><p>Public preferences</p></NativeFeaturePage>;
    }
    const view = render(<Destination />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const retirements = bridge.retire.mock.calls.length;
    expect(ready).not.toHaveBeenCalled();
    act(() => document.documentElement.classList.add("dark"));
    await act(async () => activation.resolve({ ...held!, phase: "active" }));
    await waitFor(() => expect(heldUpdate).toBe(true));
    const currentUpdate = bridge.update.mock.calls.find(([p]) => p.controlId === "profile-back" && p.revision === held!.revision && p.appearance === "dark")![0];
    expect(ready).not.toHaveBeenCalled();
    if (outcome === "owner") view.rerender(<Destination owner="owner-b" />);
    if (outcome === "closed") view.rerender(<Destination open={false} />);
    await act(async () => update.resolve(currentUpdate));
    if (outcome === "current") {
      await waitFor(() => expect(ready).toHaveBeenCalledOnce());
      expect(view.getByRole("dialog", { name: "Preferences" })).toBeVisible();
      expect(bridge.prepare).toHaveBeenCalledTimes(2);
      expect(bridge.retire).toHaveBeenCalledTimes(retirements);
      expect(currentUpdate.enabled).toBe(false); // Ready is staging, not touch authority.
      act(() => bridge.callbacks.get("readmissionRequested")?.(undefined));
      await waitFor(() => expect(bridge.update.mock.calls.filter(([p]) => p.controlId === "profile-back").length).toBeGreaterThan(1));
      expect(ready).toHaveBeenCalledOnce();
    } else {
      expect(ready).not.toHaveBeenCalled();
      if (outcome === "closed") expect(view.queryByRole("dialog", { name: "Preferences" })).toBeNull();
    }
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...currentUpdate, sequence: 1, privacyGeneration: 0 }));
    expect(back).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(bridge.releaseContentPane).toHaveBeenCalled());
  });
  it.each(["profile-back", "profile-close"] as const)("revokes pending %s on dismissal while retaining the exiting pane's isolation", async controlId => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back", "close"], independentControls: true,
      coherentPresentation: true, ownedContentPane: true, retainedControls: true, inPlaceUpdates: true });
    bridge.acquireContentPane.mockImplementation(async identity => ({ ...identity, phase: "active" }));
    bridge.releaseContentPane.mockImplementation(async identity => ({ ...identity, phase: "retired" }));
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(node => {
      const style = computedStyle(node);
      return node.matches('[data-slot="dialog-content"]') ? new Proxy(style, {
        get: (target, key) => key === "animationName"
          ? node.getAttribute("data-state") === "closed" ? "pane-exit" : "none"
          : key === "display" ? "block" : Reflect.get(target, key, target),
      }) : style;
    });
    const back = vi.fn(), close = vi.fn(), ready = vi.fn();
    const pane = (open: boolean) => <NativeFeaturePage pane open={open} title="Preferences" owner="owner-a" context="pane"
      onBack={back} onClose={close} onReady={ready}><p>Public preferences</p></NativeFeaturePage>;
    const view = render(pane(true));
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    await waitFor(() => expect(bridge.activate.mock.calls.some(([p]) => p.controlId === controlId)).toBe(true));
    let confirm: ((receipt: { valid: boolean }) => void) | undefined;
    bridge.confirmChoice.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    const projection = bridge.prepare.mock.calls.find(([p]) => p.controlId === controlId)![0];
    const updateSequence = bridge.update.mock.calls.filter(([p]) => p.controlId === controlId).at(-1)?.[0].updateSequence ?? 0;
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...projection, sequence: 1, updateSequence, privacyGeneration: 0 }));
    await waitFor(() => expect(bridge.confirmChoice).toHaveBeenCalledOnce());
    view.rerender(pane(false));
    const exiting = document.querySelector('[data-slot="dialog-content"][data-state="closed"]');
    expect(exiting).not.toBeNull();
    expect(nativeShellOverlayBlocked()).toBe(true); // DOM exit still owns isolation.
    await act(async () => { confirm?.({ valid: true }); });
    expect(back).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(exiting!.querySelector('button[aria-label="Back in Profile"]')).toBeDisabled();
    expect(exiting!.querySelector('button[aria-label="Close Profile"]')).toBeDisabled();
    view.unmount();
    await waitFor(() => expect(bridge.releaseContentPane).toHaveBeenCalled());
  });
  it("keeps moving Profile controls React across inner routes and ownership changes", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back", "close"], independentControls: true, inPlaceUpdates: true });
    const close = vi.fn();
    const view = render(<ProfilePane open owner="owner-a" onOpenChange={close} />);
    const original = view.getByRole("button", { name: "Close Profile" });
    for (const query of ["profile_pane=1&profile_panel=security", "profile_pane=1&profile_panel=security&profile_detail=vault"]) {
      profile.query = query;
      // The real Next context publishes query changes. Our lightweight mock
      // is not a context provider, so a new callback makes memo observe it.
      view.rerender(<ProfilePane open owner="owner-a" onOpenChange={(next) => close(next)} />);
      expect(view.getByRole("button", { name: "Close Profile" })).toBe(original);
      await waitFor(() => expect(view.getByRole("button", { name: "Back in Profile" })).toBeVisible());
    }
    view.rerender(<ProfilePane open owner="owner-b" onOpenChange={close} />);
    fireEvent.click(view.getByRole("button", { name: "Close Profile" }));
    expect(close).toHaveBeenCalledExactlyOnceWith(false);
    expect(bridge.prepare.mock.calls.filter(([p]) => ["profile-back", "close"].includes(p.kind))).toHaveLength(0);
  });

  it("commits DOM isolation before activation and waits for retirement during session checks", async () => {
    measureSlot();
    const onBack = vi.fn();
    const view = render(<Harness onBack={onBack} />);
    const button = view.getByLabelText("Go back", { selector: "button" });
    bridge.activate.mockImplementation(async (value) => {
      expect(button).toBeDisabled();
      expect(button).toHaveStyle({ visibility: "hidden" });
      return { ...value, phase: "active" };
    });
    await waitFor(() => expect(bridge.activate).toHaveBeenCalled());
    const approval = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(approval.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...bridge.activate.mock.calls.at(-1)![0], sequence: 1, privacyGeneration: 0 }));
    const pending = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValue(pending.promise);
    view.rerender(<Harness suppressed onBack={onBack} />);
    await act(async () => { approval.resolve({ valid: true }); });
    expect(onBack).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    await waitFor(() => expect(bridge.retire.mock.calls.at(-1)?.[0].revision).toBeGreaterThan(bridge.activate.mock.calls.at(-1)![0].revision));
    await act(async () => { pending.resolve({ ...bridge.retire.mock.calls.at(-1)![0], phase: "retired" }); });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).not.toHaveStyle({ visibility: "hidden" });
    bridge.retire.mockImplementation(async (value) => ({ ...value, phase: "retired" }));
  });
  it("does not remove a replacement when old activation fails after a context change", async () => {
    measureSlot();
    const pending = deferred<ChromeAcknowledgement>();
    bridge.activate.mockReturnValueOnce(pending.promise);
    const view = render(<Harness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(1));
    view.rerender(<Harness context="/one/profile/account" />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const retirements = bridge.retire.mock.calls.length;
    await act(async () => { pending.reject(new Error("synthetic_old_ack_failure")); });
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(view.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(view.getByRole("button", { hidden: true })).toBeDisabled();
  });
  it("applies committed theme tokens and rejects an old-theme choice during replacement", async () => {
    measureSlot();
    const onBack = vi.fn();
    const view = render(<Harness onBack={onBack} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(1));
    const old = bridge.activate.mock.calls.at(-1)![0];
    const approval = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(approval.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, privacyGeneration: 0 }));
    await act(async () => {
      document.documentElement.style.setProperty("--app-accent", "#112233");
      document.documentElement.style.setProperty("--app-accent-deep", "#445566");
      document.documentElement.classList.add("dark");
      // Resolve before React commits the observer's replacement projection.
      // A class-only change must fence the old control immediately too.
      approval.resolve({ valid: true });
      await approval.promise;
    });
    expect(onBack).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.prepare.mock.calls.at(-1)![0]).toMatchObject({
      appearance: "dark", accentHex: "#112233", foregroundHex: "#445566",
    }));
    await waitFor(() => expect(bridge.activate.mock.calls.at(-1)![0].revision).toBeGreaterThan(old.revision));
    expect(view.queryByRole("button", { name: "Go back" })).toBeNull();
    act(() => {
      document.documentElement.style.setProperty("--app-accent", "#667788");
      writeAccent("gold");
    });
    await waitFor(() => expect(bridge.prepare.mock.calls.at(-1)![0].accentHex).toBe("#667788"));
  });
  it.each(["web", "android", "older-ios", "older-wrapper", "older-single-control-wrapper"])("retains the existing control on %s", async (platform) => {
    bridge.platform = platform.startsWith("older-") ? "ios" : platform;
    if (platform === "older-ios") bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [] });
    if (platform === "older-wrapper") bridge.getCapabilities.mockResolvedValue({ contractVersion: 1, families: ["back"] });
    if (platform === "older-single-control-wrapper") bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back"] });
    const view = render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    expect(view.getByRole("button", { name: "Go back" })).not.toBeDisabled();
    expect(bridge.prepare).not.toHaveBeenCalled();
  });
});
