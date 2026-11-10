import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import { NativeOwnedChoiceLease, validOwnedChoiceProjection, type OwnedChoiceEvent, type OwnedChoiceProjection, type OwnedChoiceReceipt } from "@/lib/capacitor/native-owned-choice";

const runtime = vi.hoisted(() => ({
  native: true, current: true, revision: 0, privacy: new Set<(state: unknown) => void>(),
  appearance: { appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111" },
  events: new Set<(event: OwnedChoiceEvent) => void>(), capabilities: vi.fn(), prepare: vi.fn(), retire: vi.fn(), read: vi.fn(), update: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/wallet", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ nativeOwnedChoicesEnabled: () => runtime.native }));
vi.mock("@/lib/auth/use-session-chrome-suppression", () => ({ isSessionChromeSuppressed: () => false }));
vi.mock("@/lib/capacitor/native-navigation", () => ({ useNativeNavigationOverlayRef: (ref: unknown) => ref }));
vi.mock("@/lib/capacitor/native-presentation-regions", () => ({ useNativeOverlayCollisionPadding: (padding: unknown) => padding }));
vi.mock("@/lib/capacitor/native-control-appearance", () => ({
  readNativeControlAppearance: () => runtime.appearance,
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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 24, y: 80, width: 180, height: 44,
    top: 80, right: 204, bottom: 124, left: 24, toJSON: () => ({}) });
  runtime.appearance = { appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111" };
  runtime.capabilities.mockReset().mockResolvedValue({ ownedChoices: true });
  runtime.prepare.mockReset().mockImplementation(async state => receipt(state));
  runtime.retire.mockReset().mockImplementation(async state => ({ ...state, phase: "retired" }));
  runtime.read.mockReset(); runtime.update.mockReset().mockImplementation(async state => ({ ...state, phase: "active" }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("shared Select native presentation", () => {
  it("anchors to the actual trigger and retires when its retained tab becomes inactive", async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 24, y: 80, width: 180, height: 44, top: 80, right: 204, bottom: 124, left: 24, toJSON: () => ({}) });
    const view = render(<div role="tabpanel"><Field /></div>);
    try {
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
      expect(runtime.prepare.mock.calls[0][0].anchor).toEqual({ x: 24, y: 80, width: 180, height: 44,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
      view.container.querySelector('[role="tabpanel"]')!.setAttribute("aria-hidden", "true");
      await waitFor(() => expect(runtime.retire).toHaveBeenCalledOnce());
      expect(screen.queryByRole("listbox")).toBeNull();
    } finally { bounds.mockRestore(); }
  });

  it("reopens after its retained pane leaves during capability admission", async () => {
    const capabilities = deferred<{ ownedChoices: boolean }>();
    runtime.capabilities.mockReturnValueOnce(capabilities.promise);
    const view = render(<div role="tabpanel"><Field /></div>);
    const panel = view.container.querySelector('[role="tabpanel"]')!;
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(runtime.capabilities).toHaveBeenCalledOnce());
    panel.setAttribute("aria-hidden", "true");
    await act(async () => capabilities.resolve({ ownedChoices: true }));
    expect(runtime.prepare).not.toHaveBeenCalled();
    panel.removeAttribute("aria-hidden");
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
  });

  it("keeps an initially unset choice empty if it becomes a required named field", () => {
    const field = (named: boolean) => <form><Select {...(named ? { name: "choice", required: true } : {})}>
      <SelectTrigger aria-label="Time"><SelectValue placeholder="Choose a time" /></SelectTrigger>
      <SelectContent><SelectItem value="first">First</SelectItem><SelectItem value="second">Second</SelectItem></SelectContent>
    </Select></form>;
    const view = render(field(false));
    view.rerender(field(true));
    const form = view.container.querySelector("form")!;
    expect(new FormData(form).get("choice")).toBe("");
    expect(form.checkValidity()).toBe(false);
  });
  it("opens the country selector after cancelling an adjacent native choice without replacing either form owner", async () => {
    render(<form><Field /><Select value="none"><SelectTrigger aria-label="Issuing region"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="none">Select region…</SelectItem>
        {COUNTRY_PHONE_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent></Select></form>);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Visibility" }), { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    const first = runtime.prepare.mock.calls[0][0] as OwnedChoiceProjection;
    await act(async () => { for (const callback of runtime.events) {
      const { phase: _, ...identity } = receipt(first);
      callback({ ...identity, sequence: 1, outcome: "cancelled" });
    } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Issuing region" }), { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledTimes(2));
    const second = runtime.prepare.mock.calls[1][0] as OwnedChoiceProjection;
    expect(second.options).toHaveLength(COUNTRY_PHONE_OPTIONS.length + 1);
    expect(validOwnedChoiceProjection(second)).toBe(true);
    expect(second.visitId).not.toBe(first.visitId);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it.each(["private-a", undefined])("hydrates a form initialized with %s without replacing its trigger or changing its option owner", async defaultValue => {
    runtime.native = false;
    const container = document.createElement("div");
    container.innerHTML = renderToString(<form><Field defaultValue={defaultValue} /></form>);
    document.body.append(container);
    const trigger = container.querySelector('[role="combobox"]');
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: Root | undefined;
    try {
      runtime.native = true;
      await act(async () => { root = hydrateRoot(container, <form><Field defaultValue={defaultValue} /></form>); });
      expect(container.querySelector('[role="combobox"]')).toBe(trigger);
      if (defaultValue === undefined) expect(trigger).not.toHaveAttribute("data-native-owned-choice");
      else expect(trigger).toHaveAttribute("data-native-owned-choice", "ready");
      expect(new FormData(container.querySelector("form")!).get("posture")).toBe(defaultValue ?? "");
      expect(error).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount()); container.remove(); error.mockRestore();
    }
  });
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
  it("uses the committed theme when capabilities resolve after a preference change", async () => {
    const capabilities = deferred<{ ownedChoices: boolean }>();
    runtime.capabilities.mockReturnValueOnce(capabilities.promise);
    render(<Field />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(runtime.capabilities).toHaveBeenCalledOnce());
    runtime.appearance = { appearance: "dark", accentHex: "#D19A66", foregroundHex: "#E0A36A" };
    await act(async () => capabilities.resolve({ ownedChoices: true }));
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    expect(runtime.prepare.mock.calls[0][0]).toMatchObject(runtime.appearance);
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
    const changed = vi.fn();
    const view = render(<form><Field onValueChange={changed} /></form>);
    const form = view.container.querySelector("form")!;
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    await act(async () => runtime.events.forEach(callback => callback(choose(runtime.prepare.mock.calls[0][0]))));
    expect(new FormData(form).get("posture")).toBe("private-b");
    expect(trigger).toHaveTextContent("Ask first");
    await act(async () => { form.reset(); });
    expect(new FormData(form).get("posture")).toBe("private-a");
    expect(trigger).toHaveTextContent("Private");
    expect(changed).toHaveBeenCalledExactlyOnceWith("private-b");
  });

  it("retires an open choice on form reset and ignores its late selection", async () => {
    const changed = vi.fn();
    const view = render(<form><Field onValueChange={changed} /></form>);
    const form = view.container.querySelector("form")!;
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    const pending = runtime.prepare.mock.calls[0][0] as OwnedChoiceProjection;
    await act(async () => { form.reset(); });
    await waitFor(() => expect(runtime.retire).toHaveBeenCalledOnce());
    await act(async () => runtime.events.forEach(callback => callback(choose(pending))));
    expect(changed).not.toHaveBeenCalled();
    expect(trigger).toHaveTextContent("Private");
  });

  it("preserves the selection when the form cancels its reset", async () => {
    const view = render(<form onReset={event => event.preventDefault()}><Field /></form>);
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    await act(async () => runtime.events.forEach(callback => callback(choose(runtime.prepare.mock.calls[0][0]))));
    await act(async () => { view.container.querySelector("form")!.reset(); });
    expect(trigger).toHaveTextContent("Ask first");
  });

  it("resets a Select associated with a form outside its tree", async () => {
    const view = render(<><form id="choice-form" /><Field form="choice-form" /></>);
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce());
    await act(async () => runtime.events.forEach(callback => callback(choose(runtime.prepare.mock.calls[0][0]))));
    await act(async () => { view.container.querySelector("form")!.reset(); });
    expect(trigger).toHaveTextContent("Private");
    expect(new FormData(view.container.querySelector("form")!).get("posture")).toBe("private-a");
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
    // The original open intent survives confirmed failure; a second tap is not required.
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
  it("prepares with the latest theme received while its listener is attaching", async () => {
    const listener = deferred<{ remove: () => Promise<void> }>();
    const attach = vi.fn().mockReturnValue(listener.promise);
    const port = { prepareOwnedChoice: runtime.prepare, retireOwnedChoice: runtime.retire,
      getOwnedChoiceState: runtime.read, updateOwnedChoice: runtime.update, addListener: attach };
    const value = new NativeOwnedChoiceLease(state, port, () => true, vi.fn(), vi.fn());
    const presenting = value.present(state);
    await waitFor(() => expect(attach).toHaveBeenCalledOnce());
    const next = { appearance: "dark" as const, accentHex: "#D19A66", foregroundHex: "#E0A36A" };
    value.updateAppearance(next);
    await act(async () => listener.resolve({ remove: async () => undefined }));
    await presenting;
    expect(runtime.prepare.mock.calls[0][0]).toMatchObject(next);
    await value.retire();
  });
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
