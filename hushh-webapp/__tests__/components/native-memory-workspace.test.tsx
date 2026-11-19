import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemo, useState } from "react";
import type { NativeWorkspacePresentationOwner } from "@/lib/capacitor/native-workspace-presence";
import type { PkmNaturalModel } from "@/components/profile/use-pkm-natural-model";

type WorkspaceOptions = {
  owner: string; active: boolean; presentationOwner: NativeWorkspacePresentationOwner;
  content: { workspace: string; sections: readonly { id?: string; title?: string; rows: readonly { id: string; label: string }[] }[] };
  actions: ReadonlyMap<string, (choice: never) => void | Promise<unknown>>;
  editorKind?: string; editor?: unknown; activationRevision?: number;
};
const harness = vi.hoisted(() => ({
  enabled: true, pathname: "/one/pkm", epoch: 1, sessionCurrent: true,
  privacy: { generation: 1, appIsActive: true, shielded: false },
  options: null as WorkspaceOptions | null, registrations: 0,
  retire: vi.fn<() => Promise<boolean>>(), savedProjection: vi.fn(), savedAvailable: true,
}));

vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname }));
vi.mock("@/lib/navigation/use-profile-pane-presentation", () => ({ useProfilePanePresentation: () => ({ open: false }) }));
vi.mock("@/lib/navigation/profile-pane", () => ({ openProfilePane: vi.fn() }));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => harness.enabled }));
vi.mock("@/lib/capacitor/session-privacy", () => ({
  nativePrivacyObservation: () => ({ state: harness.privacy }),
  nativePrivacyCanInteract: (state: typeof harness.privacy | undefined) => !!state && state.appIsActive && !state.shielded,
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => harness.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === harness.epoch,
}));
vi.mock("@/components/profile/memory-commerce-summary", () => ({ useMemoryCommerceSummary: () => ({ user: null, data: null, loading: false, error: null }) }));
vi.mock("@/components/profile/pkm-saved-sharing", () => ({ usePkmSharingExpansion: () => ({ section: "", setSection: vi.fn() }) }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: () => <div data-testid="native-owner" /> }));
vi.mock("@/components/profile/native-memory-saved", () => ({
  nativeMemorySaved: (input: { model: PkmNaturalModel; handoff: (kind: string, action: () => void) => Promise<boolean>; openSharing: () => void }) => {
    harness.savedProjection(input);
    if (!harness.savedAvailable) return null;
    return {
      sections: [
        { id: "wiki", title: "Wiki", rows: [{ id: "synthetic-wiki", label: "Personal wiki" }] },
      ],
      actions: new Map([
        ["synthetic-edit", () => input.handoff("soul-editor", input.model.soul.beginEdit)],
        ["synthetic-sharing", () => input.handoff("sharing", input.openSharing)],
        ["synthetic-navigation", () => input.handoff("navigation", () => input.model.navigate("/one/files?folder=personal-wiki"))],
      ]),
    };
  },
}));
vi.mock("@/lib/capacitor/use-native-workspace", async () => {
  const React = await import("react");
  const { NativeWorkspacePresentationOwner } = await import("@/lib/capacitor/native-workspace-presence");
  return {
    useNativeWorkspacePresentation() {
      const [owner] = React.useState(() => new NativeWorkspacePresentationOwner());
      const status = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
      return { owner, status, retireForWeb: owner.retireForWeb };
    },
    useNativeWorkspace(options: WorkspaceOptions) {
      harness.options = options;
      React.useLayoutEffect(() => {
        if (!options.active) return;
        const id = {};
        let pending: Promise<boolean> | undefined;
        const retire = () => pending ??= harness.retire().then(absent => {
          options.presentationOwner.report(id, absent ? "web" : "blocked", "inactive");
          return absent;
        });
        harness.registrations += 1;
        options.presentationOwner.register(id, retire);
        options.presentationOwner.report(id, "native", "active");
        return () => { void retire(); };
      }, [options.active, options.owner, options.presentationOwner, options.activationRevision]);
      return options.active ? "native" : "web";
    },
  };
});

import { NativeMemoryWorkspace } from "@/components/profile/native-memory-workspace";

const defaultSession = Symbol("synthetic-session");
function Fixture({ owner = "synthetic-owner", session = defaultSession, version = 1, canOpen = true, onEdit = vi.fn(), onNavigate = vi.fn() }: { owner?: string; session?: symbol; version?: number; canOpen?: boolean; onEdit?: () => void; onNavigate?: (href: string) => void }) {
  const [editing, setEditing] = useState(false);
  const stable = useMemo(() => ({ owner, document: { markdown: `synthetic ${version}`, persisted: true }, memoryCards: [], metadata: {}, sharingManifests: {} }), [owner, version]);
  const model = {
    ownerId: owner, presentationIdentity: session, authLoading: false, canOpen, signedIn: true,
    nativeDataState: "loaded", selectedCard: null, selectedMetadataDomain: null, homeSearchQuery: "",
    memoryCards: stable.memoryCards, metadata: stable.metadata, sharingManifests: stable.sharingManifests,
    navigate: onNavigate,
    captureSessionCurrent: () => harness.sessionCurrent,
    soul: { active: !editing, editing, current: { document: stable.document, draft: "synthetic" }, verified: true, failed: false,
      beginEdit: () => { onEdit(); setEditing(true); } },
  } as unknown as PkmNaturalModel;
  return <div className="app-page-shell"><NativeMemoryWorkspace model={model} renderFallback={owners => <div data-testid="react-fallback">
    <span>{owners.commerce.loading ? "loading" : "ready"}</span><input aria-label="Memory note" /><button onClick={() => setEditing(false)}>Close editor</button>
  </div>} /></div>;
}

function invoke(id: string) {
  const action = harness.options?.actions.get(id);
  expect(action).toBeDefined();
  return action!(undefined as never);
}

beforeEach(() => {
  harness.enabled = true; harness.pathname = "/one/pkm"; harness.epoch = 1; harness.sessionCurrent = true;
  harness.privacy = { generation: 1, appIsActive: true, shielded: false };
  harness.options = null; harness.registrations = 0; harness.retire.mockReset().mockResolvedValue(true); harness.savedProjection.mockClear();
  harness.savedAvailable = true;
});
afterEach(() => { cleanup(); delete window.__HUSHH_NATIVE_TEST__; });

describe("native Memory workspace ownership", () => {
  it.each([
    ["policy", () => { harness.enabled = false; }],
    ["session", () => { harness.sessionCurrent = false; }],
    ["saved-projection-bounds", () => { harness.savedAvailable = false; }],
  ])("exposes only a fixed %s diagnostic in the opt-in test bridge", (reason, arrange) => {
    window.__HUSHH_NATIVE_TEST__ = { enabled: true };
    arrange();
    const view = render(<Fixture />);
    const bridge = window.__HUSHH_NATIVE_TEST__ as typeof window.__HUSHH_NATIVE_TEST__ & { memoryAdmission?: unknown };
    expect(bridge.memoryAdmission).toEqual({ reason, phase: "web", ownerPhase: "web", ownerReason: "inactive" });
    expect(screen.getByRole("progressbar", { name: "native-memory-admission" })).toHaveAttribute("aria-valuetext",
      `reason=${reason};phase=web;ownerPhase=web;ownerReason=inactive`);
    view.unmount();
    expect(bridge.memoryAdmission).toBeUndefined();
  });

  it("does not attach admission diagnostics without an enabled test bridge", () => {
    window.__HUSHH_NATIVE_TEST__ = { enabled: false };
    render(<Fixture />);
    expect(window.__HUSHH_NATIVE_TEST__).toEqual({ enabled: false });
    expect(screen.queryByRole("progressbar", { name: "native-memory-admission" })).toBeNull();
  });

  it("retains one workspace owner and exposes Wiki without legacy tabs", () => {
    render(<Fixture />);
    expect(screen.getByTestId("native-owner")).toBeInTheDocument();
    const owner = harness.options!.presentationOwner;
    expect(harness.options!.content.sections.map(section => section.title)).toEqual(["Wiki"]);
    expect(harness.options!.presentationOwner).toBe(owner);
    expect(harness.registrations).toBe(1);
  });

  it("renders the supplied interactive React fallback when the native flag is off", () => {
    harness.enabled = false;
    render(<Fixture />);
    expect(screen.getByTestId("react-fallback")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Memory note" }), { target: { value: "synthetic" } });
    expect(screen.getByRole("textbox", { name: "Memory note" })).toHaveValue("synthetic");
    expect(screen.queryByTestId("native-owner")).toBeNull();
    expect(harness.registrations).toBe(0);
    expect(harness.savedProjection).not.toHaveBeenCalled();
  });

  it("withholds native admission until vault unlock canOpen is true", () => {
    const view = render(<Fixture canOpen={false} />);
    expect(screen.getByTestId("react-fallback")).toBeVisible();
    expect(harness.options!.active).toBe(false);
    view.rerender(<Fixture canOpen />);
    expect(screen.queryByTestId("react-fallback")).toBeNull();
    expect(screen.getByTestId("native-owner")).toBeInTheDocument();
    expect(harness.options!.active).toBe(true);
  });

  it("waits for exact native retirement before opening a rich child, then re-admits after it closes", async () => {
    harness.pathname = "/one/pkm/";
    let resolve!: (value: boolean) => void;
    const retirement = new Promise<boolean>(done => { resolve = done; });
    harness.retire.mockReturnValueOnce(retirement);
    const onEdit = vi.fn();
    render(<Fixture onEdit={onEdit} />);
    const owner = harness.options!.presentationOwner;
    let pending!: Promise<unknown>;
    act(() => { pending = Promise.resolve(invoke("synthetic-edit")); });
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("react-fallback")).toBeNull();
    await act(async () => { resolve(true); await pending; });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("react-fallback")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(screen.getByTestId("native-owner")).toBeInTheDocument();
    expect(harness.options!.presentationOwner).toBe(owner);
    expect(harness.registrations).toBe(2);
  });

  it("does not admit the Memory workspace on a child route", () => {
    harness.pathname = "/one/pkm/recent/";
    render(<Fixture />);
    expect(harness.options!.active).toBe(false);
    expect(harness.registrations).toBe(0);
    expect(screen.getByTestId("react-fallback")).toBeVisible();
  });

  it("does not expose a replacement or invoke the action when native retirement fails", async () => {
    harness.retire.mockResolvedValueOnce(false);
    const onEdit = vi.fn(); render(<Fixture onEdit={onEdit} />);
    await act(async () => { await invoke("synthetic-edit"); });
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("react-fallback")).toBeNull();
    expect(harness.options!.presentationOwner.getSnapshot()).toMatchObject({ phase: "blocked", held: true });
  });

  it("re-admits a retained Memory route after an authored child route returns", async () => {
    const onNavigate = vi.fn(); const view = render(<Fixture onNavigate={onNavigate} />);
    const owner = harness.options!.presentationOwner;
    await act(async () => { await invoke("synthetic-navigation"); });
    expect(onNavigate).toHaveBeenCalledWith("/one/files?folder=personal-wiki");
    expect(screen.getByTestId("react-fallback")).toBeVisible();
    harness.pathname = "/one/files"; view.rerender(<Fixture onNavigate={onNavigate} />);
    harness.pathname = "/one/pkm"; view.rerender(<Fixture onNavigate={onNavigate} />);
    expect(screen.getByTestId("native-owner")).toBeInTheDocument();
    expect(harness.options!.presentationOwner).toBe(owner);
    expect(harness.registrations).toBe(2);
  });

  it("does not retain an unopened child across a vault presentation change", async () => {
    const initial = Symbol("unlocked-before");
    const replacement = Symbol("unlocked-after");
    const view = render(<Fixture session={initial} />);
    await act(async () => { await invoke("synthetic-navigation"); });
    expect(harness.options!.active).toBe(false);
    view.rerender(<Fixture session={replacement} />);
    expect(harness.options!.active).toBe(true);
  });

  it.each(["epoch", "privacy"] as const)("rejects a stale %s after delayed retirement", async changed => {
    let resolve!: (value: boolean) => void;
    harness.retire.mockReturnValueOnce(new Promise<boolean>(done => { resolve = done; }));
    const onEdit = vi.fn(); render(<Fixture onEdit={onEdit} />);
    let pending!: Promise<unknown>;
    act(() => { pending = Promise.resolve(invoke("synthetic-edit")); });
    if (changed === "epoch") harness.epoch += 1;
    else harness.privacy = { ...harness.privacy, generation: 2 };
    await act(async () => { resolve(true); await pending; });
    expect(onEdit).not.toHaveBeenCalled();
    expect(harness.registrations).toBe(2);
    expect(harness.options!.presentationOwner.getSnapshot().held).toBe(true);
  });

  it("re-admits native and refuses a child captured from a replaced document", async () => {
    let resolve!: (value: boolean) => void;
    harness.retire.mockReturnValueOnce(new Promise<boolean>(done => { resolve = done; }));
    const onEdit = vi.fn(); const view = render(<Fixture version={1} onEdit={onEdit} />);
    let pending!: Promise<unknown>;
    act(() => { pending = Promise.resolve(invoke("synthetic-edit")); });
    view.rerender(<Fixture version={2} onEdit={onEdit} />);
    await act(async () => { resolve(true); await pending; });
    expect(onEdit).not.toHaveBeenCalled();
    expect(harness.registrations).toBe(2);
    expect(harness.options!.presentationOwner.getSnapshot().held).toBe(true);
  });

  it("does not open a prior owner's child after an account change", async () => {
    let resolve!: (value: boolean) => void;
    harness.retire.mockReturnValueOnce(new Promise<boolean>(done => { resolve = done; }));
    const onEdit = vi.fn(); const view = render(<Fixture owner="owner-a" onEdit={onEdit} />);
    let pending!: Promise<unknown>;
    act(() => { pending = Promise.resolve(invoke("synthetic-edit")); });
    view.rerender(<Fixture owner="owner-b" onEdit={onEdit} />);
    await act(async () => { resolve(true); await pending; });
    expect(onEdit).not.toHaveBeenCalled();
    expect(harness.options!.owner).toBe("owner-b");
    expect(harness.options!.presentationOwner.getSnapshot().held).toBe(true);
  });
});
