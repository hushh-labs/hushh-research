import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { NativeOwnedChoiceLease, validOwnedChoiceProjection, type OwnedChoiceEvent, type OwnedChoiceProjection, type OwnedChoiceReceipt } from "@/lib/capacitor/native-owned-choice";

const runtime = vi.hoisted(() => ({
  native: true, current: true, revision: 0, privacy: new Set<(state: unknown) => void>(),
  events: new Set<(event: OwnedChoiceEvent) => void>(), capabilities: vi.fn(), prepare: vi.fn(), retire: vi.fn(), read: vi.fn(), update: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/wallet", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ nativeOwnedChoicesEnabled: () => runtime.native }));
vi.mock("@/lib/auth/use-session-chrome-suppression", () => ({ isSessionChromeSuppressed: () => false }));
vi.mock("@/lib/capacitor/native-navigation", () => ({ useNativeNavigationOverlayRef: (ref: unknown) => ref }));
vi.mock("@/lib/capacitor/native-presentation-regions", () => ({ useNativeOverlayCollisionPadding: (padding: unknown) => padding }));
vi.mock("@/lib/capacitor/native-control-appearance", () => ({
  readNativeControlAppearance: () => ({ appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111" }),
}));
vi.mock("@/lib/capacitor/native-drawer-owner", () => ({
  captureNativeDrawerOwner: () => runtime.current ? ({ documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1 }) : null,
  createNativePresentationIdentity: () => runtime.current ? ({ documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: ++runtime.revision }) : null,
  nativeDrawerOwnerIsCurrent: () => runtime.current,
}));
vi.mock("@/lib/capacitor/session-privacy", () => ({
  getNativeSessionPrivacyState: async () => ({ appIsActive: true, shielded: false, generation: 3 }),
  subscribeNativeSessionPrivacy: async (callback: (state: unknown) => void) => {
    runtime.privacy.add(callback); return { remove: async () => { runtime.privacy.delete(callback); } };
  },
}));
vi.mock("@/lib/vault/session-epoch", () => ({ subscribeVaultSessionEpoch: () => () => undefined }));
vi.mock("@/lib/capacitor/native-drawers", () => ({
  nativeDrawerAcknowledged: <T,>(promise: Promise<T>) => promise,
  nativeDrawers: () => ({
    getCapabilities: runtime.capabilities, prepareOwnedChoice: runtime.prepare,
    retireOwnedChoice: runtime.retire, getOwnedChoiceState: runtime.read, updateOwnedChoice: runtime.update,
    addListener: async (_: string, callback: (event: OwnedChoiceEvent) => void) => {
      runtime.events.add(callback); return { remove: async () => { runtime.events.delete(callback); } };
    },
  }),
}));

function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function receipt(state: OwnedChoiceProjection, phase: "active" | "retired" = "active"): OwnedChoiceReceipt {
  const { documentId, ownerEpoch, ownerGeneration, revision, visitId, privacyGeneration, updateSequence } = state;
  return { documentId, ownerEpoch, ownerGeneration, revision, visitId, privacyGeneration, updateSequence, phase };
}
function choose(state: OwnedChoiceProjection, index = 1): OwnedChoiceEvent {
  const { phase: _, ...identity } = receipt(state);
  return { ...identity, sequence: 1, outcome: "selected", handle: state.options[index].handle };
}
function Field(props: Partial<React.ComponentProps<typeof Select>> = {}) {
  return <Select defaultValue="private-a" name="posture" {...props}>
    <SelectTrigger aria-label="Visibility"><SelectValue /></SelectTrigger>
    <SelectContent><SelectItem value="private-a">Private</SelectItem><SelectItem value="private-b">Ask first</SelectItem></SelectContent>
  </Select>;
}

beforeEach(() => {
  runtime.native = true; runtime.current = true; runtime.events.clear(); runtime.privacy.clear();
  runtime.capabilities.mockReset().mockResolvedValue({ ownedChoices: true });
  runtime.prepare.mockReset().mockImplementation(async state => receipt(state));
  runtime.retire.mockReset().mockImplementation(async state => ({ ...state, phase: "retired" }));
  runtime.read.mockReset(); runtime.update.mockReset().mockImplementation(async state => ({ ...state, phase: "active" }));
});
afterEach(cleanup);

describe("shared Select native presentation", () => {
  it("authorizes a popup after owner restoration without replacing its preloaded form", async () => {
    runtime.current = false;
    const view = render(<form><Field /></form>);
    const trigger = screen.getByRole("combobox", { name: "Visibility" });
    runtime.current = true;
    view.rerender(<form><Field /></form>);
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Visibility" })).toBe(trigger);
  });
  it("cancels pending capability admission through Back without reopening or dispatching", async () => {
    const capabilities = deferred<{ ownedChoices: boolean }>();
    runtime.capabilities.mockReturnValueOnce(capabilities.promise);
    const changed = vi.fn(); render(<Field onValueChange={changed} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(runtime.capabilities).toHaveBeenCalledOnce());
    await act(async () => { expect(unwindBackLayer("/wallet")).toBe(true); });
    await act(async () => capabilities.resolve({ ownedChoices: true }));
    expect(runtime.prepare).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    // A new user intent is independent of the cancelled capability request.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
  });
  it("keeps the form owner and controlled refusal while projecting opaque handles only", async () => {
    const changed = vi.fn();
    const view = render(<form><Field value="private-a" onValueChange={changed} required /></form>);
    const form = view.container.querySelector("form")!;
    const trigger = screen.getByRole("combobox", { name: "Visibility" });
    expect(new FormData(form).get("posture")).toBe("private-a");
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    const state = runtime.prepare.mock.calls[0][0] as OwnedChoiceProjection;
    expect(JSON.stringify(state)).not.toContain("private-a");
    expect(JSON.stringify(state)).not.toContain("private-b");
    expect(state.options.map(option => option.label)).toEqual(["Private", "Ask first"]);
    expect(screen.queryByRole("listbox")).toBeNull();
    const currentChanged = vi.fn();
    view.rerender(<form><Field value="private-a" onValueChange={currentChanged} required /></form>);
    await act(async () => { runtime.events.forEach(callback => callback(choose(state))); });
    expect(changed).not.toHaveBeenCalled();
    expect(currentChanged).toHaveBeenCalledExactlyOnceWith("private-b");
    expect(new FormData(form).get("posture")).toBe("private-a");
    expect(screen.getByRole("combobox", { name: "Visibility" })).toBe(trigger);
    expect(form.querySelector("select")).toBeRequired();
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledTimes(2));
    await act(async () => { runtime.events.forEach(callback => callback(choose(runtime.prepare.mock.calls[1][0], 0))); });
    expect(currentChanged).toHaveBeenCalledOnce();
  });

  it("retains uncontrolled form reset semantics after native choice", async () => {
    const view = render(<form><Field /></form>);
    const form = view.container.querySelector("form")!;
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    await act(async () => runtime.events.forEach(callback => callback(choose(runtime.prepare.mock.calls[0][0]))));
    expect(new FormData(form).get("posture")).toBe("private-b");
    await act(async () => { form.reset(); });
    expect(new FormData(form).get("posture")).toBe("private-a");
  });

  it("does not substitute a web popup while failed native presentation is still retiring", async () => {
    const retirement = deferred<OwnedChoiceReceipt>();
    runtime.prepare.mockRejectedValue(new Error("synthetic uncertain admission"));
    runtime.retire.mockReturnValue(retirement.promise);
    render(<Field />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(runtime.retire).toHaveBeenCalledOnce());
    expect(screen.queryByRole("listbox")).toBeNull();
    const state = runtime.prepare.mock.calls[0][0];
    await act(async () => retirement.resolve(receipt(state, "retired")));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeVisible());
    expect(runtime.prepare).toHaveBeenCalledOnce();
  });

  it("keeps controlled-open presentation on its established renderer", () => {
    render(<Field open />);
    expect(screen.getByRole("listbox")).toBeVisible();
    expect(runtime.prepare).not.toHaveBeenCalled();
  });

  it("transfers newly controlled opening only after the current native sheet disappears", async () => {
    const retirement = deferred<OwnedChoiceReceipt>();
    runtime.retire.mockReturnValue(retirement.promise);
    const view = render(<Field />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    const changedOpen = vi.fn();
    view.rerender(<Field open onOpenChange={changedOpen} />);
    await waitFor(() => expect(runtime.retire).toHaveBeenCalledOnce());
    expect(screen.queryByRole("listbox")).toBeNull();
    await act(async () => retirement.resolve(receipt(runtime.prepare.mock.calls[0][0], "retired")));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeVisible());
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(changedOpen).toHaveBeenCalledWith(false);
  });
});

describe("private immediate-choice boundary", () => {
  const state: OwnedChoiceProjection = {
    documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1, visitId: "public-visit",
    privacyGeneration: 3, updateSequence: 1, appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111",
    title: "Synthetic choices", options: [{ handle: "opaque-a", label: "Private", selected: true, disabled: false },
      { handle: "opaque-b", label: "Ask first", selected: false, disabled: false }],
  };
  function lease(complete = vi.fn(), failed = vi.fn()) {
    const port = { prepareOwnedChoice: runtime.prepare, retireOwnedChoice: runtime.retire,
      getOwnedChoiceState: runtime.read, updateOwnedChoice: runtime.update,
      addListener: async (_: "ownedChoice", callback: (event: OwnedChoiceEvent) => void) => {
        runtime.events.add(callback); return { remove: async () => { runtime.events.delete(callback); } };
      } };
    return { value: new NativeOwnedChoiceLease(state, port, () => true, complete, failed), complete, failed };
  }
  it("rejects extra protected fields, malformed options and duplicate handles", () => {
    expect(validOwnedChoiceProjection(state)).toBe(true);
    for (const invalid of [{ ...state, vaultKey: "forbidden" }, { ...state, options: [null] },
      { ...state, options: [state.options[0], state.options[0]] },
      { ...state, options: [{ ...state.options[0], value: "feature-secret" }] }]) {
      expect(validOwnedChoiceProjection(invalid as never)).toBe(false);
    }
  });
  it("buffers until actual presentation and consumes only one current terminal choice", async () => {
    const active = deferred<OwnedChoiceReceipt>(); runtime.prepare.mockReturnValue(active.promise);
    const run = lease(), prepared = run.value.present(state);
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    const deliver = (event: OwnedChoiceEvent) => runtime.events.forEach(callback => callback(event));
    deliver({ ...choose(state), ownerEpoch: "retired-owner" });
    deliver({ ...choose(state), privacyGeneration: 2 });
    deliver({ ...choose(state), handle: "unknown-handle" });
    deliver({ ...choose(state), updateSequence: 9 });
    expect(run.complete).not.toHaveBeenCalled();
    deliver(choose(state)); expect(run.complete).not.toHaveBeenCalled();
    active.resolve(receipt(state)); await prepared;
    expect(run.complete).toHaveBeenCalledExactlyOnceWith(choose(state));
    deliver(choose(state)); expect(run.complete).toHaveBeenCalledOnce();
  });
  it("revokes callbacks immediately on privacy change and waits for native disappearance", async () => {
    const retirement = deferred<OwnedChoiceReceipt>(); runtime.retire.mockReturnValue(retirement.promise);
    const run = lease(); await run.value.present(state);
    runtime.privacy.forEach(callback => callback({ appIsActive: false, shielded: true, generation: 4 }));
    runtime.events.forEach(callback => callback(choose(state)));
    expect(run.complete).not.toHaveBeenCalled(); expect(run.failed).not.toHaveBeenCalled();
    retirement.resolve(receipt(state, "retired"));
    await waitFor(() => expect(run.failed).toHaveBeenCalledExactlyOnceWith(true, "invalidated"));
    expect(runtime.events.size).toBe(0);
  });
});
