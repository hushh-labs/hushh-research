// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validNativeWorkspace, type NativeWorkspaceProjection } from "@/lib/capacitor/native-workspace";

const state = vi.hoisted(() => ({ enabled: true, path: "/one/connect", content: null as unknown, actions: new Map(), apply: vi.fn(), directory: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path, useRouter: () => ({ push: state.push }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/feed/feed-push-prompt", () => ({ useFeedPushPrompt: () => null }));
vi.mock("@/components/consent/payouts/use-payout-snapshot", () => ({ usePayoutSnapshot: () => ({ token: null }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true }) }));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => state.enabled }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: vi.fn() }));
vi.mock("@/components/app-ui/app-page-shell", () => ({ AppPageShell: ({ children }: { children?: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/lib/capacitor/use-native-workspace", () => ({
  useNativeWorkspacePresentation: () => ({ owner: {}, status: { phase: "native", reason: "active", held: true }, retireForWeb: vi.fn() }),
  useNativeWorkspace: (value: { content: unknown; actions: Map<string, () => unknown> }) => { state.apply(); state.content = value.content; state.actions = value.actions; return "native"; },
}));
vi.mock("@/lib/capacitor/use-native-workspace-handoff", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/capacitor/use-native-workspace-handoff")>(),
  useNativeWorkspaceHandoff: () => ({ activationRevision: 0, intent: { current: 0 }, handoff: vi.fn() }),
}));

import { NativeConnectWorkspace, type NativeConnectModel } from "../native-connect-workspace";
import { NativeFeedWorkspace, type NativeFeedModel } from "@/components/feed/native-feed-workspace";
import { groupFeedSmsAlerts } from "@/lib/feed/feed-sms-grouping";
import { MapPin } from "@/components/icons";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";
import { useBackLayer } from "@/lib/navigation/back-layers";

function model(): NativeConnectModel {
  return { owner: "synthetic-owner", current: () => true, surface: "all", selectSurface: vi.fn(), view: "discover", setView: vi.fn(),
    directory: "people", directories: [{ value: "people", label: "People", run: vi.fn() }, { value: "advisors", label: "RIAs", run: state.directory }],
    query: "", setQuery: vi.fn(), searchLabel: "Search people", heading: "People", people: [], loading: false, error: null,
    empty: "No people found", actions: [], footer: [], selectionMode: false, selectionCount: 0, selectionLimit: 10, cancelSelection: vi.fn(), webOnly: false, webChildOpen: false };
}
function projection(): NativeWorkspaceProjection {
  return { documentId: "document", ownerEpoch: "owner", ownerGeneration: 1, revision: 1, updateSequence: 1, privacyGeneration: 0, isolationGeneration: 0,
    appearance: "light", accentHex: "#007aff", foregroundHex: "#111111", canvasHex: "#ffffff",
    frame: { x: 0, y: 100, width: 390, height: 500, viewportWidth: 390, viewportHeight: 844, layoutRevision: 1 },
    ...(state.content as NativeWorkspaceProjection) };
}
beforeEach(() => { state.enabled = true; state.path = "/one/connect"; state.content = null; vi.clearAllMocks(); });
describe("Connect workspace admission contract", () => {
  it("uses supported workspace directory choices and invokes the existing selection callback", async () => {
    render(<NativeConnectWorkspace model={model()} fallback={<p>Complete React Connect</p>} />);
    const content = projection();
    expect(validNativeWorkspace(content)).toBe(true);
    const directory = content.sections.flatMap(section => section.rows).find(row => row.label === "Directory")!;
    expect(directory.options?.find(option => option.label === "People")?.selected).toBe(true);
    await act(async () => { await state.actions.get(directory.options!.find(option => option.label === "RIAs")!.id)!(); });
    expect(state.directory).toHaveBeenCalledTimes(1);
    // Finite choices use workspace action handles, never Profile/URL commands.
    expect(validNativeWorkspace({ ...content, sections: [{ id: "directory", rows: [{ id: "menu", label: "Directory", enabled: true,
      options: [{ id: "people", label: "People", selected: true }, { id: "advisors", label: "RIAs", selected: false, href: "/ria" }] }] }] } as never)).toBe(false);
  });
  it("keeps both navigation levels as tabs and uses the same authored callbacks", async () => {
    const value = model();
    render(<NativeConnectWorkspace model={value} fallback={<p>React</p>} />);
    const content = projection();
    expect(content.tabs?.options.map(option => option.label)).toEqual(["Connections", "Circles"]);
    expect(content.secondaryTabs?.options.map(option => option.label)).toEqual(["My connections", "Find people"]);
    expect(content.sections.flatMap(section => section.rows).some(row => row.label === "View")).toBe(false);
    expect(validNativeWorkspace(content)).toBe(true);
    await act(async () => { await state.actions.get(content.secondaryTabs!.options[0]!.id)!(); });
    expect(value.setView).toHaveBeenCalledWith("connections");
    await act(async () => { await state.actions.get(content.tabs!.options[1]!.id)!(); });
    expect(value.selectSurface).toHaveBeenCalledWith("circles");
    expect(validNativeWorkspace({ ...content, secondaryTabs: { ...content.secondaryTabs!, options: content.tabs!.options } })).toBe(false);
    expect(validNativeWorkspace({ ...content, secondaryTabs: { ...content.secondaryTabs!, options: content.secondaryTabs!.options.map(option => ({ ...option, selected: true })) } })).toBe(false);
  });
  it("keeps the full React route when the experimental renderer is off", () => {
    state.enabled = false;
    render(<NativeConnectWorkspace model={model()} fallback={<p>Complete React Connect</p>} />);
    expect(screen.getByText("Complete React Connect")).toBeVisible();
    expect(state.apply).not.toHaveBeenCalled();
  });
  it("keeps native confirmation cancellation separate from the existing writer", async () => {
    const write = vi.fn(), cancel = vi.fn();
    render(<NativeConnectWorkspace model={{ ...model(), confirmation: {
      title: "Remove connection", description: "Remove this connection?",
      confirm: { key: "remove-confirm:synthetic", label: "Remove", destructive: true, run: write }, cancel,
    } }} fallback={<p>Complete React Connect</p>} />);
    const content = projection();
    expect(validNativeWorkspace(content)).toBe(true);
    expect(content.tabs).toBeUndefined();
    expect(content.search).toBeUndefined();
    const rows = content.sections.flatMap(section => section.rows);
    await act(async () => { await state.actions.get(rows.find(row => row.label === "Cancel")!.id)!(); });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    await act(async () => { await state.actions.get(rows.find(row => row.label === "Remove")!.id)!(); });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("keeps person primary and message actions independent, and suppresses both in selection", async () => {
    const open = vi.fn(), message = vi.fn(), toggle = vi.fn();
    const person = { key: "public-person", label: "Public Person", photoUrl: null, verified: true,
      primary: { key: "profile", label: "Open profile", run: open }, actions: [{ key: "message", label: "Message", run: message }] };
    const { rerender } = render(<NativeConnectWorkspace model={{ ...model(), people: [person] }} fallback={<p>React</p>} />);
    let row = projection().sections.flatMap(section => section.rows).find(row => row.label === person.label)!;
    expect(validNativeWorkspace(projection())).toBe(true);
    expect(row.avatar?.verified).toBe(true);
    await act(async () => { await state.actions.get(row.inlineActions![0]!.id)!(); });
    expect(message).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled();
    await act(async () => { await state.actions.get(row.id)!(); });
    expect(open).toHaveBeenCalledTimes(1);
    rerender(<NativeConnectWorkspace model={{ ...model(), selectionMode: true, people: [{ ...person, selected: false, toggle }] }} fallback={<p>React</p>} />);
    row = projection().sections.flatMap(section => section.rows).find(row => row.label === person.label)!;
    expect(row.inlineActions).toBeUndefined();
    await act(async () => { await state.actions.get(row.id)!(); });
    expect(toggle).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1); expect(message).toHaveBeenCalledTimes(1);
  });
});

function feed(records: NativeFeedModel["records"]): NativeFeedModel {
  return { owner: "synthetic-owner", current: () => true, records, loading: false, errors: [], retry: vi.fn(), overflow: [],
    hasNew: false, showNew: vi.fn(), canLoadMore: false, loadingMore: false, loadMoreError: null, loadMore: vi.fn(),
    canClear: false, clearing: false, clearArmed: false, clear: vi.fn(), cancelClear: vi.fn(), removing: null,
    openHistory: vi.fn(), removeHistory: vi.fn(), webChildOpen: false };
}
function incident(overrides: Partial<FeedActionable> = {}): FeedActionable {
  return { id: "public-incident", title: "Public incident", description: "Ended", sortAt: 0, icon: MapPin, iconTone: "red", actions: [],
    person: { displayName: "Public Person", photoUrl: null }, smsEmergency: { senderId: "public-sender" }, ...overrides };
}
describe("Native Feed action parity", () => {
  it("substitutes phone decisions without inventing a row action or exposing desktop writers", async () => {
    state.path = "/one/feed";
    const review = vi.fn(), allow = vi.fn();
    const item = incident({ actions: [{ key: "allow", label: "Allow", tone: "success", run: allow }],
      phoneActions: [{ key: "review", label: "Review", tone: "primary", run: review }] });
    render(<NativeFeedWorkspace model={feed([{ key: "action", lane: "Needs you", kind: "action", value: item }])} fallback={<p>React</p>} />);
    const row = projection().sections.flatMap(section => section.rows).find(row => row.label === item.title)!;
    expect(validNativeWorkspace(projection())).toBe(true);
    expect(row.readOnly).toBe(true); expect(state.actions.has(row.id)).toBe(false);
    expect(row.inlineActions?.map(action => action.label)).toEqual(["Review"]);
    await act(async () => { await state.actions.get(row.inlineActions![0]!.id)!(); });
    expect(review).toHaveBeenCalledTimes(1); expect(allow).not.toHaveBeenCalled();
  });
  it("keeps singleton SMS intent direct and expands repeated incidents without replacing Feed", async () => {
    state.path = "/one/feed";
    const active = incident({ href: "/one/location?grantId=public", description: "Active" });
    const records = (items: FeedActionable[]): NativeFeedModel["records"] => [{ key: "sms", lane: "SMS alerts", kind: "sms", value: groupFeedSmsAlerts(items)[0]! }];
    const { rerender } = render(<NativeFeedWorkspace model={feed(records([active]))} fallback={<p>React</p>} />);
    let row = projection().sections.flatMap(section => section.rows).find(row => row.label === active.title)!;
    await act(async () => { await state.actions.get(row.id)!(); });
    expect(state.push).toHaveBeenCalledWith(active.href);
    rerender(<NativeFeedWorkspace model={feed(records([incident()]))} fallback={<p>React</p>} />);
    row = projection().sections.flatMap(section => section.rows).find(row => row.label === active.title)!;
    expect(row.readOnly).toBe(true); expect(state.actions.has(row.id)).toBe(false);
    rerender(<NativeFeedWorkspace model={feed(records([active, incident({ id: "public-second", title: "Second incident", sortAt: 1 })]))} fallback={<p>React</p>} />);
    row = projection().sections.flatMap(section => section.rows).find(row => row.expanded === false)!;
    await act(async () => { await state.actions.get(row.id)!(); });
    expect(projection().title).toBe("Feed");
    expect(projection().sections.flatMap(section => section.rows).filter(row => row.avatar)).toHaveLength(3);
    expect(validNativeWorkspace(projection())).toBe(true);
    rerender(<NativeFeedWorkspace model={feed(records([incident()]))} fallback={<p>React</p>} />);
    expect(vi.mocked(useBackLayer).mock.calls.at(-1)?.[1]).toBe(0);
    expect(vi.mocked(useBackLayer).mock.calls.at(-1)?.[2]()).toBe(false);
  });
});
