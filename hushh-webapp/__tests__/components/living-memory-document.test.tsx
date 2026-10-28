import fs from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMirrorClaim, LiveMirrorView } from "@/lib/pkm/live-mirror-contract";
import type { MemoryRefreshStatus } from "@/lib/pkm/memory-refresh";

const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  uid: "owner-a",
  unlocked: true,
  token: "fixture-token-0",
  epoch: 0,
  view: null as LiveMirrorView | null,
  listeners: new Set<() => void>(),
  privacy: { generation: 0, appIsActive: true, shielded: false },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.navigate }) }));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativePrivacyObservation: () => ({ state: m.privacy }) }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: m.uid }, userId: m.uid }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: m.unlocked,
    vaultOwnerToken: m.token,
    vaultKey: "fixture-key",
  }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => m.epoch,
}));
vi.mock("@/lib/pkm/memory-refresh", () => ({
  peekLiveMirror: () => m.view,
}));
vi.mock("@/lib/services/cache-service", () => ({
  CacheService: {
    getInstance: () => ({
      subscribe: (listener: () => void) => {
        m.listeners.add(listener);
        return () => {
          m.listeners.delete(listener);
        };
      },
    }),
  },
}));

import { LivingMemoryDocument } from "@/components/profile/living-memory-document";
import { useNativeMemory, nativeMemoryText, type NativeMemoryModel } from "@/components/profile/use-native-memory";
import { validNativeMemoryPath, type NativeDrawerChoice, type NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { buildPkmDomainPresentation } from "@/lib/profile/pkm-profile-presentation";
import { buildPkmSectionPreviewPresentation } from "@/lib/profile/pkm-section-preview";
import { applyLiveMirrorReadTime, buildLiveMirrorProjection } from "@/lib/pkm/live-mirror-projection";
import { formatLiveMirrorDateTime, formatLiveMirrorValue, liveMirrorSourceRoute } from "@/lib/pkm/live-mirror-presentation";
import {
  appendVerifiedLivingSourceChanges,
  reconcileLivingSources,
  type LivingSourceChange,
  type LivingSourceHistory,
  type LivingSourceInput,
  type LivingSourceInventory,
} from "@/lib/pkm/living-source-records";
import type { MemoryDocument } from "@/lib/pkm/memory-document";

const T0 = "2026-10-15T10:00:00.000Z";
const T1 = "2026-10-15T10:01:00.000Z";
const NOW = "2026-10-15T10:02:00.000Z";
const UPDATED = "2026-10-15T09:30:00.000Z";
/** Four minutes after NOW: a later read of the same build, still inside the profile's freshness window. */
const READ_LATER = "2026-10-15T10:06:00.000Z";
type Step = { inputs: LivingSourceInput[]; kinds: string[]; unavailable?: string[]; now: string };

const profile = (name: string, owner = "owner-a"): LivingSourceInput => ({
  kind: "profile", id: owner, createdAt: null, updatedAt: UPDATED, value: { name, email: "owner@example.test" },
});
const consent = (id: string, scope: string): LivingSourceInput => ({
  kind: "consent", id, createdAt: T0, updatedAt: T0, value: { scope, status: "active" },
});
/** A paid document request in euros, last changed at UPDATED. */
const payment = (id: string, amountCents: number): LivingSourceInput => ({
  kind: "document_request_payment", id, createdAt: T0, updatedAt: UPDATED,
  value: { mode: "live", status: "paid", amountCents, currency: "EUR", paidAt: UPDATED },
});
const euros = (cents: number) => formatLiveMirrorValue("document_request_payment.amountCents", cents, { currency: "EUR" });

/** A real projection with read time applied, built through the real reconciler and history. */
function mirror(options: {
  steps?: Step[];
  owner?: string;
  epoch?: number;
  status?: MemoryRefreshStatus;
  readAt?: string;
  document?: Partial<MemoryDocument>;
  history?: (history: LivingSourceHistory) => LivingSourceHistory;
  /** Edits the reconciled inventory, such as adding a disagreeing copy of a record. */
  inventory?: (inventory: LivingSourceInventory) => LivingSourceInventory;
  extra?: Partial<Parameters<typeof buildLiveMirrorProjection>[0]>;
} = {}): LiveMirrorView {
  let inventory: LivingSourceInventory | null = null;
  let history: LivingSourceHistory | null = null;
  for (const step of options.steps ?? [{ inputs: [profile("SYNTHETIC_A_NAME", options.owner)], kinds: ["profile"], now: T1 }]) {
    const next = reconcileLivingSources(inventory, step.inputs, step.kinds, step.unavailable ?? [], step.now);
    history = appendVerifiedLivingSourceChanges(history, inventory, next);
    inventory = next;
  }
  const projection = buildLiveMirrorProjection({
    ownerId: options.owner ?? "owner-a",
    vaultEpoch: options.epoch ?? 0,
    now: NOW,
    inventory: inventory && options.inventory ? options.inventory(inventory) : inventory,
    history: history && options.history ? options.history(history) : history,
    document: { markdown: "", complete: true, sourceLinks: [], excludedDomains: [], freshness: [], ...options.document },
    ...options.extra,
  });
  return applyLiveMirrorReadTime(projection, options.readAt ?? NOW, options.status ?? "current");
}
/**
 * (a) memory.md, at revision 9, names the owner "Ankit K"; the verified profile says "Ankit Kumar".
 * Read four minutes after the build, so a check time shows whether it follows the read or the build.
 */
const nameConflictView = () => mirror({
  steps: [{ inputs: [profile("Ankit Kumar")], kinds: ["profile"], now: T1 }],
  readAt: READ_LATER,
  document: { freshness: [
    { domain: "one_memory", title: "Identity facts", status: "conflicted", contentRevision: 9, updatedAt: T0, cardCount: 1 },
  ] },
  extra: { nameConflict: true, nameClaims: { soul: ["Ankit K"], profile: "Ankit Kumar" } },
});
/** (b) One euro payment whose two copies at the same revision disagree on the amount; the second changed later. */
const moneyConflictView = () => mirror({
  steps: [{ inputs: [profile("Ankit Kumar"), payment("p1", 1_234)], kinds: ["profile", "document_request_payment"], now: T1 }],
  inventory: inventory => ({ ...inventory, records: inventory.records.flatMap(record => record.kind === "document_request_payment"
    ? [record, { ...record, updatedAt: T0, value: { ...record.value, amountCents: 5_678 } }] : [record]) }),
});
const fire = () => act(() => { for (const listener of m.listeners) listener(); });
const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole("tab", { name }));
const group = (title: string) =>
  screen.getByRole("heading", { name: title }).closest<HTMLElement>('[data-testid="settings-group"]')!;
const row = (title: string, label: string) =>
  within(group(title)).getByText(label).closest<HTMLElement>('[data-testid="settings-row"]')!;
const rowIn = (container: HTMLElement, title: string) =>
  within(container).getByText(title).closest<HTMLElement>('[data-testid="settings-row"]')!;

beforeEach(() => {
  m.uid = "owner-a";
  m.unlocked = true;
  m.token = "fixture-token-0";
  m.epoch = 0;
  m.view = mirror();
  m.listeners.clear();
  m.privacy = { generation: 0, appIsActive: true, shielded: false };
});
afterEach(cleanup);

describe("native Memory operation boundary", () => {
  function model(overrides: Partial<NativeMemoryModel> = {}): NativeMemoryModel {
    return { owner: "synthetic-owner", active: true, detail: null, loading: false, metadataReady: true, sharingReady: true,
      metadataFailed: false, sharingFailed: false, domains: [], connections: [], selectedDomain: null, selectedConnection: null,
      permissions: [], upgrade: null, manifestLoading: false, manifestFailed: false, pendingPermissions: {},
      preview: { open: false, title: "", presentation: null, loading: false, error: null, deletingEntityKey: null },
      openDomain: vi.fn(), openConnection: vi.fn(), openSharing: vi.fn(), openRoot: vi.fn(), refresh: vi.fn(), navigate: vi.fn(), closePreview: vi.fn(), openRetainedDetails: vi.fn(), openFinancialContext: vi.fn(),
      previewPermission: vi.fn().mockResolvedValue(undefined), setPosture: vi.fn().mockResolvedValue(undefined),
      removeEntity: vi.fn().mockResolvedValue(true), editEntity: vi.fn(), revoke: vi.fn().mockResolvedValue(undefined), ...overrides };
  }
  it("returns Live memory to its retained root and distinguishes blocked Back from a committed pop", () => {
    const input = model();
    const hook = renderHook(({ value }) => useNativeMemory(value), { initialProps: { value: input } });
    const live = hook.result.current.pages[0].sections.flatMap(section => section.rows).find(row => row.label === "Live memory")!;
    act(() => { void hook.result.current.rows.get(live.id)!({} as NativeDrawerChoice); });
    expect(hook.result.current.pages.map(page => page.id)).toEqual(["memory", "memory-live"]);
    expect(hook.result.current.navigationBlocked()).toBe(false);
    act(() => { expect(hook.result.current.back()).toBe(true); });
    expect(hook.result.current.pages.map(page => page.id)).toEqual(["memory"]);
    act(() => { void hook.result.current.rows.get(live.id)!({} as NativeDrawerChoice); });
    hook.rerender({ value: { ...input, preview: { ...input.preview, deletingEntityKey: "synthetic-pending-write" } } });
    expect(hook.result.current.navigationBlocked()).toBe(true);
    act(() => { expect(hook.result.current.back()).toBe(true); });
    expect(hook.result.current.pages.map(page => page.id)).toEqual(["memory", "memory-live"]);
    hook.rerender({ value: input });
    m.privacy.shielded = true;
    expect(hook.result.current.navigationBlocked()).toBe(true);
  });

  it("keeps shared grants opaque and fences sensitive disclosure and asynchronous copying", async () => {
    let copyAllowed = true;
    const person = { personRef: "private-person-ref", person: "Synthetic person", labels: ["Legal entity"], items: [] };
    const shared = { location: { page: "person" }, shared: { failed: false, shares: [], people: [person], refresh: vi.fn() }, person,
      received: { shares: [], failed: false, refresh: vi.fn() }, card: { items: [{ key: "private-grant-ref", label: "Legal entity", state: "ready", sensitive: false,
        sharedAt: null, accessEndsAt: null, purpose: null, fields: [{ name: "Registered agent", sensitivity: "sensitive" }],
        data: { fein: "12-3456789", trade_name: "Acme Coffee", registered_agent: "Jordan Lee" } }], retry: vi.fn() },
      exposed: [], actionRevision: "synthetic-visit", canCopy: () => copyAllowed, openShared: vi.fn(), openDrive: vi.fn(), selectPerson: vi.fn(), toggleExposure: vi.fn(), back: vi.fn(), reset: vi.fn(),
    } as unknown as NonNullable<NativeMemoryModel["shared"]>;
    const hook = renderHook(({ value }) => useNativeMemory(model({ shared: value })), { initialProps: { value: shared } });
    const reading = () => JSON.stringify(hook.result.current.pages);
    expect(validNativeMemoryPath(hook.result.current.pages)).toBe(true);
    expect(reading()).toContain("Acme Coffee");
    expect(reading()).not.toMatch(/12-3456789|Jordan Lee|private-person-ref|private-grant-ref/);
    const reveal = hook.result.current.pages.at(-1)!.sections[0]!.rows.find(row => row.label === "Show Legal entity")!;
    act(() => { void hook.result.current.rows.get(reveal.id)?.(); });
    expect(shared.toggleExposure).toHaveBeenCalledExactlyOnceWith("private-grant-ref");
    hook.rerender({ value: { ...shared, exposed: ["private-grant-ref"] } });
    expect(reading()).toContain("12-3456789");
    expect(validNativeMemoryPath([{ id: "memory" }, { id: "memory-shared" }, { id: "memory-confirm" }] as NativeProfilePage[])).toBe(false);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const exec = Object.getOwnPropertyDescriptor(document, "execCommand");
    let reject!: (error: Error) => void;
    const fallback = vi.fn(() => true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => new Promise<void>((_, failure) => { reject = failure; })) } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
    try {
      const copy = hook.result.current.pages.at(-1)!.sections[0]!.rows.find(row => row.label === "Copy Trade name")!;
      let pending: void | Promise<void> = undefined;
      act(() => { pending = hook.result.current.rows.get(copy.id)?.(); });
      copyAllowed = false; // A privacy/grant/disclosure withdrawal wins the await.
      await act(async () => { reject(new Error("clipboard_unavailable")); await pending; });
      expect(fallback).not.toHaveBeenCalled();
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard");
      if (exec) Object.defineProperty(document, "execCommand", exec); else Reflect.deleteProperty(document, "execCommand");
    }
  });
  it("bounds large category projections, preserves Unicode and rejects callbacks from a retired owner", () => {
    const text = "😀漢字".repeat(5000);
    const chunks = nativeMemoryText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every(chunk => chunk.length <= 3000 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
    const input = model({ domains: Array.from({ length: 2100 }, (_, index) => buildPkmDomainPresentation({
      domain: { key: `synthetic-domain-${index}`, displayName: `Category ${index}`, attributeCount: 1, summary: {}, availableScopes: [], lastUpdated: null }, activeGrants: [] })) });
    const hook = renderHook(({ input }) => useNativeMemory(input), { initialProps: { input } });
    const rows = hook.result.current.pages[0]!.sections[0]!.rows;
    expect(rows.length).toBeLessThanOrEqual(42);
    const command = hook.result.current.rows.get(rows.find(row => row.label === "Category 0")!.id)!;
    act(() => { void command(); });
    expect(input.openDomain).toHaveBeenCalledWith("synthetic-domain-0");
    const search = hook.result.current.pages[0]!.memorySearch!;
    act(() => { void hook.result.current.rows.get(search.id)!({ text: "Category 2099" } as NativeDrawerChoice); });
    expect(hook.result.current.pages[0]!.sections[0]!.rows.some(row => row.label === "Category 2099")).toBe(true);
    expect(hook.result.current.pages[0]!.sections[0]!.rows.some(row => row.label === "Category 0")).toBe(false);
    hook.rerender({ input: { ...input, owner: "replacement-owner" } });
    act(() => { void command(); });
    expect(input.openDomain).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(hook.result.current.pages)).not.toContain("synthetic-domain-0");
  });
  it("keeps long navigation text admissible without dropping its complete detail content", () => {
    const title = "😀".repeat(300), summary = "漢".repeat(5000);
    const domain = { ...buildPkmDomainPresentation({ domain: { key: "synthetic", displayName: "Synthetic", attributeCount: 1, summary: {}, availableScopes: [], lastUpdated: null }, activeGrants: [] }), title, summary };
    const hook = renderHook(() => useNativeMemory(model({ detail: "domain:synthetic", domains: [domain], selectedDomain: domain })));
    expect(hook.result.current.pages.every(page => page.title.length <= 256)).toBe(true);
    const details = hook.result.current.pages.at(-1)!.sections.flatMap(section => section.rows);
    expect(details.filter(row => row.readOnly).map(row => row.label).join("\n")).toContain(title);
    expect(details.every(row => row.label.length <= 4096 && (row.detail?.length ?? 0) <= 4096)).toBe(true);
    expect(details.filter(row => row.readOnly).map(row => row.label).join("")).toContain(summary);
  });
  it("keeps a failed revocation visible and rejects its confirmation across privacy generations", async () => {
    m.privacy = { generation: 0, appIsActive: true, shielded: false };
    const grant = { id: "private-grant", scope: "attr.synthetic.*", domainTitle: "Synthetic category", readableAccessLabel: "Approved details" };
    const connection = { id: "private-connection", requesterLabel: "Synthetic connection", grants: [grant], domains: ["Synthetic category"], broadAccessCount: 0, accessCount: 1 } as NativeMemoryModel["connections"][number];
    const input = model({ detail: "connection:private-connection", selectedConnection: connection, connections: [connection], revoke: vi.fn().mockRejectedValue(new Error("synthetic unavailable")) });
    const projected: NativeProfilePage[][] = [];
    const hook = renderHook(({ value }) => {
      const result = useNativeMemory(value); projected.push(result.pages); return result;
    }, { initialProps: { value: input } });
    const choose = (label: string) => {
      const row = hook.result.current.pages.at(-1)!.sections.flatMap(section => section.rows).find(row => row.label === label)!;
      return hook.result.current.rows.get(row.id)!;
    };
    act(() => { void choose("Revoke this access category")(); });
    const staleConfirm = choose("Revoke access");
    m.privacy = { ...m.privacy, generation: 1 };
    await act(async () => { await staleConfirm(); });
    expect(input.revoke).not.toHaveBeenCalled();
    act(() => { void choose("Cancel")(); });
    act(() => { void choose("Revoke this access category")(); });
    await act(async () => { await choose("Revoke access")(); });
    expect(input.revoke).toHaveBeenCalledOnce();
    expect(hook.result.current.pages.at(-1)!.id).toBe("memory-confirm");
    expect(hook.result.current.pages.at(-1)!.sections.flatMap(section => section.rows).some(row => row.label.includes("Couldn't confirm"))).toBe(true);
    expect(JSON.stringify(hook.result.current.pages)).not.toMatch(/private-grant|attr\.synthetic|private-connection/);
    const first = projected.length;
    hook.rerender({ value: { ...input, detail: "sharing", selectedConnection: null } });
    expect(projected.slice(first).every(validNativeMemoryPath)).toBe(true);
    expect(projected[first]!.map(page => page.id)).toEqual(["memory", "memory-sharing"]);
  });
  it("keeps valid ancestry when a saved entity disappears before confirmation settlement", () => {
    const domain = buildPkmDomainPresentation({ domain: { key: "synthetic", displayName: "Synthetic", attributeCount: 1, summary: {}, availableScopes: [], lastUpdated: null }, activeGrants: [] });
    const input = model({ detail: "domain:synthetic", domains: [domain], selectedDomain: domain,
      preview: { open: true, title: "Synthetic section", loading: false, error: null, deletingEntityKey: null,
        presentation: { title: "Synthetic section", stats: [], groups: [{ kind: "entities", items: [{ key: "display-only", title: "Synthetic record", fields: [], deletable: true }] }] } } });
    const projected: NativeProfilePage[][] = [];
    const hook = renderHook(({ value }) => { const state = useNativeMemory(value); projected.push(state.pages); return state; }, { initialProps: { value: input } });
    const choose = (label: string) => {
      const row = hook.result.current.pages.at(-1)!.sections.flatMap(section => section.rows).find(row => row.label === label)!;
      act(() => { void hook.result.current.rows.get(row.id)!(); });
    };
    choose("Synthetic record"); choose("Remove saved entry");
    const first = projected.length;
    hook.rerender({ value: { ...input, preview: { ...input.preview, presentation: null } } });
    expect(projected.slice(first).every(validNativeMemoryPath)).toBe(true);
    expect(hook.result.current.pages.at(-1)!.sections.flatMap(section => section.rows).find(row => row.label === "Remove")?.enabled).toBe(false);
    hook.rerender({ value: { ...input, preview: { ...input.preview, open: false, presentation: null } } });
    expect(hook.result.current.pages.map(page => page.id)).toEqual(["memory", "memory-domain"]);
    expect(hook.result.current.back()).toBe(false);
    expect(input.removeEntity).not.toHaveBeenCalled();
  });
  it("changes the opaque action handle when a different saved record reuses its display position", () => {
    const presentation = (id: string) => buildPkmSectionPreviewPresentation({ domain: "financial", domainTitle: "Finance",
      permissionLabel: "Context", topLevelScopePath: "context", value: { context: { entries: [{ id, text: "Same visible text", category: "general" }] } } });
    const domain = buildPkmDomainPresentation({ domain: { key: "financial", displayName: "Finance", attributeCount: 1, summary: {}, availableScopes: [], lastUpdated: null }, activeGrants: [] });
    const input = model({ detail: "domain:financial", domains: [domain], selectedDomain: domain,
      preview: { open: true, title: "Context", loading: false, error: null, deletingEntityKey: null, presentation: presentation("original_private_id") } });
    const hook = renderHook(({ value }) => useNativeMemory(value), { initialProps: { value: input } });
    const row = () => hook.result.current.pages.at(-1)!.sections.flatMap(section => section.rows).find(row => row.label === "General")!;
    const oldHandle = row().id;
    hook.rerender({ value: { ...input, preview: { ...input.preview, presentation: presentation("replacement_private_id") } } });
    expect(row().id).not.toBe(oldHandle);
    expect(hook.result.current.rows.has(oldHandle)).toBe(false);
    expect(JSON.stringify(hook.result.current.pages)).not.toMatch(/original_private_id|replacement_private_id/);
  });
});

describe("Profile Live Mirror", () => {
  it("opens the existing Saved and Add workspace only while unlocked", () => {
    const rendered = render(<LivingMemoryDocument />);
    fireEvent.click(screen.getByRole("button", { name: /Saved and Add/ }));
    expect(m.navigate).toHaveBeenCalledExactlyOnceWith("/one/pkm");
    expect(screen.getByText(/SYNTHETIC_A_NAME/)).toBeInTheDocument();
    m.unlocked = false;
    m.epoch++;
    rendered.rerender(<LivingMemoryDocument />);
    expect(screen.queryByRole("button", { name: /Saved and Add/ })).toBeNull();
  });

  it("announces only the headline; the ticking check time stays outside the live region", () => {
    m.view = mirror({ readAt: "2026-10-15T10:09:00.000Z" });
    render(<LivingMemoryDocument />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("May be out of date");
    expect(status.parentElement!.textContent).toBe("May be out of dateLast checked 8 min ago");
  });

  it("shows one row per record with values people can read", () => {
    m.view = mirror({ steps: [{ inputs: [
      profile("Ankit"),
      { kind: "consent", id: "c1", createdAt: T0, updatedAt: T0,
        value: { scope: "attr.financial.*", status: "active", expiresAt: "2026-11-01T00:00:00.000Z" } },
      { kind: "document_earning", id: "e1", createdAt: T0, updatedAt: T0,
        value: { stripeMode: "live", status: "succeeded", grossCents: 123_456, netCents: 120_000, createdAt: "2026-10-01T08:30:00.000Z" } },
    ], kinds: ["profile", "consent", "document_earning"], now: T1 }] });
    const { container } = render(<LivingMemoryDocument />);
    expect(within(row("Earnings", "Earning 1")).getByText("Gross: $1,234.56 · Net: $1,200.00 · Status: Paid")).toBeInTheDocument();
    expect(row("Consents", "Consent 1").textContent).toMatch(/Scope: Financial data · Status: Active · Expires: (Oct 31|Nov 1), 2026/);
    expect(screen.getAllByRole("button", { name: /^Earning 1/ })).toHaveLength(1);
    for (const raw of ["123456", "(cents)", "succeeded", "attr.financial", "2026-11-01T00:00:00.000Z", "2026-10-01T08:30:00.000Z"])
      expect(container.textContent).not.toContain(raw);
    fireEvent.click(screen.getByRole("button", { name: /^Earning 1/ }));
    const dialog = screen.getByRole("dialog", { name: "Source details" });
    expect(within(rowIn(dialog, "Mode")).getByText("Live")).toBeInTheDocument();
  });

  it("states the open-and-unlocked boundary in plain words and never shows raw states", () => {
    m.view = mirror({
      status: "refresh_failed",
      steps: [{ inputs: [profile("Ankit"), consent("c1", "attr.food.*")], kinds: ["profile", "consent", "connection"], now: T1 },
        { inputs: [profile("Ankit")], kinds: ["profile", "connection"], unavailable: ["consent"], now: T1 }],
      extra: {
        pending: { version: 1, kinds: { consent: { count: 3, firstOccurredAt: T0, lastOccurredAt: T1, historySequence: 3 } } },
        health: { version: 1, kinds: { connection: { lastLagMs: 42_000, lagSamplesMs: [42_000], lastVerifiedAt: T1 } } },
      },
    });
    const { container } = render(<LivingMemoryDocument />);
    expect(screen.getByText("Updates while the app is open and unlocked.")).toBeInTheDocument();
    expect(within(row("Sources", "Consents")).getByText("Couldn’t check · last checked 1 min ago · 3 changes waiting")).toBeInTheDocument();
    expect(within(row("Sources", "Connections")).getByText(/Updated 42 sec after change/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/partial|refresh_failed|refresh pending|refresh_pending|24\/7|always on|while (the app is )?closed/i);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("keeps withheld and unavailable saved sections in different rows", () => {
    m.view = mirror({ document: {
      excludedDomains: ["secrets"],
      freshness: [{ domain: "professional", title: "Professional", status: "unavailable", contentRevision: null, updatedAt: null, cardCount: 0 }],
    } });
    render(<LivingMemoryDocument />);
    expect(within(row("Saved details", "Secrets")).getByText("Withheld")).toBeInTheDocument();
    expect(within(row("Saved details", "Secrets")).getByText("Kept out of memory")).toBeInTheDocument();
    expect(within(row("Saved details", "Professional")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(row("Saved details", "Professional")).getByText("Couldn’t check")).toBeInTheDocument();
  });

  it("opens a record's source details and closes them with Done", () => {
    m.view = mirror({ steps: [
      { inputs: [profile("Ankit Kumar Singh")], kinds: ["profile"], now: T0 },
      { inputs: [profile("Ankit")], kinds: ["profile"], now: T1 },
    ] });
    render(<LivingMemoryDocument />);
    fireEvent.click(screen.getByRole("button", { name: /^Profile/ }));
    const dialog = screen.getByRole("dialog", { name: "Source details" });
    expect(within(rowIn(dialog, "Name")).getByText("Ankit")).toBeInTheDocument();
    expect(within(rowIn(dialog, "From")).getByText("Profile")).toBeInTheDocument();
    expect(within(dialog).getByText("2")).toBeInTheDocument();
    for (const at of [UPDATED, T1]) expect(dialog.querySelector(`time[datetime="${at}"]`)).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows removals, gaps and the retention boundary in history without inventing values", () => {
    const gap = (sequence: number, committedChanges = 3, verifiedChanges = 1): LivingSourceChange => ({
      sequence, kind: "consent", id: "*", revision: 0, operation: "gap", capturedAt: T1, sourceUpdatedAt: null,
      value: { reason: "unobserved_changes", committedChanges, verifiedChanges, firstOccurredAt: T0, lastOccurredAt: T1 },
    });
    const steps = [
      { inputs: [profile("Ankit"), consent("c1", "OLD_CONSENT_SCOPE")], kinds: ["profile", "consent"], now: T0 },
      { inputs: [profile("Ankit")], kinds: ["profile", "consent"], now: T1 },
    ];
    m.view = mirror({ steps, history: history => ({ ...history, truncatedAt: T0, firstRetainedSequence: 6,
      changes: [...history.changes.map(change => ({ ...change, sequence: change.sequence + 5 })),
        gap(history.nextSequence + 5), gap(history.nextSequence + 6, 1, 0)] }) });
    const view = render(<LivingMemoryDocument />);
    openTab("History");
    expect(screen.getByText("5 older changes not kept")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.getByText("Details hidden")).toBeInTheDocument();
    expect(screen.getByText("3 changes made, only the latest seen")).toBeInTheDocument();
    expect(screen.getByText("1 change made, nothing new seen")).toBeInTheDocument();
    expect(screen.getByText("Only changes seen while open and unlocked")).toBeInTheDocument();
    expect(view.container.textContent).not.toContain("OLD_CONSENT_SCOPE");
    view.unmount();

    m.view = mirror({ steps, history: history => ({ ...history,
      changes: Array.from({ length: 51 }, (_, index) => gap(index + 1)), firstRetainedSequence: 1, truncatedAt: null }) });
    render(<LivingMemoryDocument />);
    openTab("History");
    expect(screen.queryByText(/older changes not kept/)).toBeNull();
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByTestId("settings-row")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show more changes" }));
    expect(within(panel).getAllByTestId("settings-row")).toHaveLength(51);
  });

  it("renders the preview as safe Markdown with hostile values as literal text", () => {
    const hostile = "# Hi ![t](https://x.test/p.png) <script>alert(1)</script> [l](javascript:alert(1))";
    m.view = mirror({ steps: [{ inputs: [profile(hostile)], kinds: ["profile"], now: T1 }] });
    const { container } = render(<LivingMemoryDocument />);
    openTab("Preview");
    const preview = screen.getByLabelText("Live memory preview");
    // The panel's own h2 titles the section; the preview never repeats it as an h1.
    expect(container.querySelector("h1")).toBeNull();
    expect(preview.querySelector("h2, h3, h4")?.textContent).toBe("Profile");
    expect(preview.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    // Owner text renders as written, with no invisible characters that would ride along on a copy.
    expect(preview.textContent).not.toContain("\u2060");
    expect(preview.textContent)
      .toContain("Name: # Hi ![t](https://x.test/p.png) <script>alert(1)</script> [l](javascript:alert(1))");
    // The only links are the generated source links inside the app.
    for (const anchor of preview.querySelectorAll("a")) {
      expect(anchor.getAttribute("href")).toMatch(/^\/(?!\/)/);
      expect(anchor.getAttribute("href")).not.toMatch(/x\.test|javascript:/);
      expect(anchor.getAttribute("target")).toBeNull();
    }
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect([...container.querySelectorAll("a")].some(anchor => anchor.getAttribute("href")?.startsWith("javascript:"))).toBe(false);
  });

  it("moves to Updating and then shows the new verified value without a remount", () => {
    m.view = mirror({ steps: [{ inputs: [profile("Ankit Kumar Singh")], kinds: ["profile"], now: T0 }] });
    const { container } = render(<LivingMemoryDocument />);
    const section = container.firstElementChild;
    expect(screen.getByText(/^Name: Ankit Kumar Singh ·/)).toBeInTheDocument();
    m.view = mirror({ steps: [{ inputs: [profile("Ankit Kumar Singh")], kinds: ["profile"], now: T0 }], status: "refresh_pending" });
    fire();
    expect(screen.getByRole("status")).toHaveTextContent("Updating");
    m.view = mirror({ steps: [
      { inputs: [profile("Ankit Kumar Singh")], kinds: ["profile"], now: T0 },
      { inputs: [profile("Ankit")], kinds: ["profile"], now: T1 },
    ] });
    fire();
    expect(screen.getByRole("status")).toHaveTextContent("Up to date");
    expect(within(screen.getByRole("tabpanel")).getByText(/^Name: Ankit ·/)).toBeInTheDocument();
    expect(screen.queryByText(/Ankit Kumar Singh/)).toBeNull();
    expect(container.firstElementChild).toBe(section);
  });

  it("never shows another owner's or epoch's mirror, and shows only a status line while locked", () => {
    const view = render(<LivingMemoryDocument />);
    expect(screen.getByText(/SYNTHETIC_A_NAME/)).toBeInTheDocument();

    m.uid = "owner-b";
    view.rerender(<LivingMemoryDocument />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking sources");
    expect(view.container.textContent).not.toContain("SYNTHETIC_A_NAME");

    m.uid = "owner-a";
    m.epoch++;
    m.token = "fixture-token-1";
    view.rerender(<LivingMemoryDocument />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking sources");
    expect(view.container.textContent).not.toContain("SYNTHETIC_A_NAME");

    m.unlocked = false;
    view.rerender(<LivingMemoryDocument />);
    expect(view.container.textContent).toBe("Memory lockedUnlock to see it");

    m.unlocked = true;
    m.view = mirror({ epoch: m.epoch, steps: [{ inputs: [profile("SYNTHETIC_RENEWED")], kinds: ["profile"], now: T1 }] });
    view.rerender(<LivingMemoryDocument />);
    fire();
    expect(screen.getByText(/SYNTHETIC_RENEWED/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Up to date");
    view.unmount();
    expect(m.listeners.size).toBe(0);
  });

  it("lists every side of a disagreement under one heading, chooses neither, and links to each place to fix it", () => {
    expect(liveMirrorSourceRoute("profile")).toEqual({ href: "/one/profile/account", label: "Edit profile" });
    m.view = nameConflictView();
    const first = render(<LivingMemoryDocument />);
    // The headline stays the only live region.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Needs your review");
    const name = row("Sources disagree", "Name");
    expect(within(name).getByText(`Your memory: Ankit K · Changed ${formatLiveMirrorDateTime(T0)} · Version 9`)).toBeInTheDocument();
    // Checked at T1 and read at READ_LATER: 5 min, not the 1 min between the check and the build.
    expect(within(name).getByText("Profile: Ankit Kumar · Checked 5 min ago · Version 1")).toBeInTheDocument();
    // The heading says it once: no badge on its rows, and no separate "Review" group.
    expect(within(group("Sources disagree")).queryByText("Needs review")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Review" })).toBeNull();

    fireEvent.click(within(name).getByRole("button"));
    const dialog = screen.getByRole("dialog", { name: "Source details" });
    expect(within(rowIn(dialog, "Your memory: Ankit K")).getByText(`Changed ${formatLiveMirrorDateTime(T0)} · Version 9`)).toBeInTheDocument();
    expect(within(rowIn(dialog, "Profile: Ankit Kumar")).getByText("Checked 5 min ago · Version 1")).toBeInTheDocument();
    // One link per place a side is fixed, in claim order, each titled by where it goes.
    expect(within(dialog).getAllByRole("link").map(link => link.getAttribute("href"))).toEqual(["/one/pkm", "/one/profile/account"]);
    expect(within(dialog).getByRole("link", { name: "Edit memory.md" })).toHaveAttribute("href", "/one/pkm");
    expect(within(dialog).getByRole("link", { name: "Edit profile" })).toHaveAttribute("href", "/one/profile/account");
    expect(within(dialog).queryByText("Fix at source")).toBeNull();
    // A fix link closes the sheet first. jsdom cannot follow it; cancel the default, keep the handler.
    const memory = within(dialog).getByRole("link", { name: "Edit memory.md" });
    memory.addEventListener("click", event => event.preventDefault());
    fireEvent.click(memory);
    expect(screen.queryByRole("dialog")).toBeNull();
    first.unmount();

    // Negative control: with no disagreement there is nothing to review.
    m.view = mirror({ steps: [{ inputs: [profile("Ankit Kumar")], kinds: ["profile"], now: T1 }] });
    render(<LivingMemoryDocument />);
    expect(screen.queryByRole("heading", { name: "Sources disagree" })).toBeNull();
    expect(screen.queryByText("Needs review")).toBeNull();
  });

  it("shows a money disagreement in each copy's own currency, a numbered copy per line", () => {
    m.view = moneyConflictView();
    render(<LivingMemoryDocument />);
    expect([euros(1_234), euros(5_678)]).toEqual(["€12.34", "€56.78"]);
    const amount = row("Sources disagree", "Amount");
    expect(within(amount).getByText(`Document payment 1, copy 1: ${euros(1_234)} · Changed ${formatLiveMirrorDateTime(UPDATED)} · Version 1`))
      .toBeInTheDocument();
    expect(within(amount).getByText(`Document payment 1, copy 2: ${euros(5_678)} · Changed ${formatLiveMirrorDateTime(T0)} · Version 1`))
      .toBeInTheDocument();
    expect(amount.textContent).not.toContain("$");
    // The record itself only says that its sources disagree; no amount is chosen.
    expect(within(row("Document payments", "Document payment 1")).getByText("Sources disagree")).toBeInTheDocument();

    fireEvent.click(within(amount).getByRole("button"));
    const dialog = screen.getByRole("dialog", { name: "Source details" });
    expect(within(rowIn(dialog, `Document payment 1, copy 1: ${euros(1_234)}`))
      .getByText(`Changed ${formatLiveMirrorDateTime(UPDATED)} · Version 1`)).toBeInTheDocument();
    expect(within(dialog).getByText(`Document payment 1, copy 2: ${euros(5_678)}`)).toBeInTheDocument();
    // Both copies are fixed in one place, so there is one link, titled by where it goes.
    const route = liveMirrorSourceRoute("document_request_payment")!;
    expect(within(dialog).getAllByRole("link")).toHaveLength(1);
    expect(within(dialog).getByRole("link", { name: route.label })).toHaveAttribute("href", route.href);
  });

  it("never shows a disagreement about another person's identifier, even in a view that skipped read time", () => {
    // Build and read time both drop these; this view stands in for one that did not.
    const side = (copy: number, value: string): LiveMirrorClaim => ({ source: "document_request_payment", origin: "record",
      label: `Document payment 1, copy ${copy}`, value, revision: 1, sourceUpdatedAt: UPDATED, verifiedAt: T1 });
    m.view = {
      ...mirror({ steps: [{ inputs: [profile("Ankit Kumar"), payment("p1", 1_234)], kinds: ["profile", "document_request_payment"], now: T1 }] }),
      conflicts: [
        { predicate: "document_request_payment.counterpartRef", label: "Person", claims: [side(1, "PERSON_REF_X"), side(2, "PERSON_REF_Y")] },
      ],
    };
    render(<LivingMemoryDocument />);
    expect(screen.queryByRole("heading", { name: "Sources disagree" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/PERSON_REF_[XY]/);
  });

  it("sends each source and record to where it is fixed, titled by where it goes", () => {
    const profileRoute = liveMirrorSourceRoute("profile")!;
    const consentRoute = liveMirrorSourceRoute("consent")!;
    m.view = mirror({ steps: [{ inputs: [profile("Ankit"), consent("c1", "attr.food.*")], kinds: ["profile", "consent"], now: T1 }] });
    render(<LivingMemoryDocument />);
    // The whole source row is the link, and it keeps its state.
    const source = within(row("Sources", "Profile")).getByRole("link");
    expect(source).toHaveAttribute("href", profileRoute.href);
    for (const text of ["Profile", "Current", profileRoute.label]) expect(within(source).getByText(text)).toBeInTheDocument();
    expect(within(row("Sources", "Consents")).getByRole("link")).toHaveAttribute("href", consentRoute.href);

    fireEvent.click(screen.getByRole("button", { name: /^Profile/ }));
    let dialog = screen.getByRole("dialog", { name: "Source details" });
    expect(within(dialog).getAllByRole("link")).toHaveLength(1);
    const fix = within(dialog).getByRole("link", { name: profileRoute.label });
    expect(fix).toHaveAttribute("href", profileRoute.href);
    expect(within(dialog).queryByText("Fix at source")).toBeNull();
    fix.addEventListener("click", event => event.preventDefault());
    fireEvent.click(fix);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Consent 1/ }));
    dialog = screen.getByRole("dialog", { name: "Source details" });
    expect(within(dialog).getByRole("link", { name: consentRoute.label })).toHaveAttribute("href", consentRoute.href);
  });

  it("renders a money source as a GFM table that keeps each amount whole, with owner URLs and emails as text", () => {
    m.view = mirror({ steps: [{
      inputs: [profile("www.example.test https://x.test/p"), payment("p1", 1_234)],
      kinds: ["profile", "document_request_payment"], now: T1,
    }] });
    const { container } = render(<LivingMemoryDocument />);
    openTab("Preview");
    const preview = screen.getByLabelText("Live memory preview");
    const table = preview.querySelector("table");
    expect(table).not.toBeNull();
    expect(within(table!).getByText(euros(1_234)).tagName).toBe("TD");
    const text = preview.textContent!;
    expect(text).not.toContain("\u2060");
    expect(text).toContain("Name: www.example.test https://x.test/p");
    expect(text).toContain("Email: owner@example.test");
    // Owner URLs and emails never become links; only in-app routes do.
    const anchors = [...preview.querySelectorAll("a")];
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(anchor.getAttribute("href")).toMatch(/^\/(?!\/)/);
    for (const tag of ["pre", "img", "script"]) expect(container.querySelector(tag)).toBeNull();
    // jsdom has no layout, so the phone-width rule is checked where it lives: the
    // preview's cells keep one line and the table scrolls instead of breaking amounts.
    expect(preview).toHaveClass("live-mirror-markdown");
    const css = fs.readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");
    expect(css).toContain(".live-mirror-markdown table { overflow-wrap: normal; }");
    expect(css).toContain(".live-mirror-markdown :is(th, td) { white-space: nowrap; }");
  });
});
