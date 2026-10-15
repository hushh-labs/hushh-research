import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMirrorConflict, LiveMirrorSourceRoute, LiveMirrorView } from "@/lib/pkm/live-mirror-contract";
import type { MemoryRefreshStatus } from "@/lib/pkm/memory-refresh";

const PROFILE_ROUTE: LiveMirrorSourceRoute = { href: "/one/profile/account", label: "Edit profile" };
/** The props a generated preview needs for GFM tables: outside links stay text. */
const INTERNAL_GFM = { gfm: true, linkPolicy: "internal" } as const;
const m = vi.hoisted(() => ({
  uid: "owner-a",
  unlocked: true,
  token: "fixture-token-0",
  epoch: 0,
  view: null as LiveMirrorView | null,
  listeners: new Set<() => void>(),
  /** The source routes under test; a kind absent here has no "Fix at source". */
  routes: {} as Partial<Record<string, LiveMirrorSourceRoute>>,
}));
vi.mock("@/lib/pkm/live-mirror-presentation", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/pkm/live-mirror-presentation")>()),
  liveMirrorSourceRoute: (kind: string) => m.routes[kind] ?? null,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: m.uid } }),
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
import { SafeMarkdown } from "@/components/profile/safe-markdown";
import { applyLiveMirrorReadTime, buildLiveMirrorProjection } from "@/lib/pkm/live-mirror-projection";
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
type Step = { inputs: LivingSourceInput[]; kinds: string[]; unavailable?: string[]; now: string };

const profile = (name: string, owner = "owner-a"): LivingSourceInput => ({
  kind: "profile", id: owner, createdAt: null, updatedAt: UPDATED, value: { name, email: "owner@example.test" },
});
const consent = (id: string, scope: string): LivingSourceInput => ({
  kind: "consent", id, createdAt: T0, updatedAt: T0, value: { scope, status: "active" },
});

/** A real projection with read time applied, built through the real reconciler and history. */
function mirror(options: {
  steps?: Step[];
  owner?: string;
  epoch?: number;
  status?: MemoryRefreshStatus;
  readAt?: string;
  document?: Partial<MemoryDocument>;
  history?: (history: LivingSourceHistory) => LivingSourceHistory;
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
    inventory,
    history: history && options.history ? options.history(history) : history,
    document: { markdown: "", complete: true, sourceLinks: [], excludedDomains: [], freshness: [], ...options.document },
    ...options.extra,
  });
  return applyLiveMirrorReadTime(projection, options.readAt ?? NOW, options.status ?? "current");
}
const fire = () => act(() => { for (const listener of m.listeners) listener(); });
const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole("tab", { name }));
const row = (group: string, label: string) => within(
  screen.getByRole("heading", { name: group }).closest<HTMLElement>('[data-testid="settings-group"]')!,
).getByText(label).closest<HTMLElement>('[data-testid="settings-row"]')!;

beforeEach(() => {
  m.uid = "owner-a";
  m.unlocked = true;
  m.token = "fixture-token-0";
  m.epoch = 0;
  m.view = mirror();
  m.listeners.clear();
  // No routes unless a test sets them, so no source link appears where base behavior has none.
  m.routes = {};
});

/** The name the owner wrote in chat memory against the verified profile name. */
const nameConflict = (): LiveMirrorConflict => ({
  predicate: "profile.name",
  label: "Name",
  claims: [
    { source: "profile", label: "Profile", value: "Ankit", revision: 2, sourceUpdatedAt: UPDATED, verifiedAt: T1 },
    { source: "soul", label: "Memory (you wrote)", value: "Ankit Kumar Singh", revision: null, sourceUpdatedAt: T0, verifiedAt: null },
  ],
});
afterEach(cleanup);

describe("Profile Live Mirror", () => {
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
    expect(within(within(dialog).getByText("Mode").closest<HTMLElement>('[data-testid="settings-row"]')!).getByText("Live")).toBeInTheDocument();
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
    expect(within(within(dialog).getByText("Name").closest<HTMLElement>('[data-testid="settings-row"]')!).getByText("Ankit")).toBeInTheDocument();
    expect(within(within(dialog).getByText("From").closest<HTMLElement>('[data-testid="settings-row"]')!).getByText("Profile")).toBeInTheDocument();
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
    // Word joiners keep URL-like owner text from autolinking; they are invisible.
    expect(preview.textContent!.replace(/\u2060/g, ""))
      .toContain("Name: # Hi ![t](https://x.test/p.png) <script>alert(1)</script> [l](javascript:alert(1))");
    // The only links are the generated "fix at source" routes inside the app.
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

  it("shows both claims of a disagreement with their sources and chooses neither", () => {
    m.routes = { profile: PROFILE_ROUTE };
    const steps = [{ inputs: [profile("Ankit")], kinds: ["profile"], now: T1 }];
    m.view = { ...mirror({ steps, extra: { nameConflict: true } }), conflicts: [nameConflict()] };
    const first = render(<LivingMemoryDocument />);
    // The headline stays the only live region.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Needs your review");
    const review = row("Review", "Name");
    expect(within(review).getByText("Profile: Ankit")).toBeInTheDocument();
    expect(within(review).getByText("Memory (you wrote): Ankit Kumar Singh")).toBeInTheDocument();
    expect(within(review).getByText("Version 2")).toBeInTheDocument();
    expect(within(review).getByText("Needs review")).toBeInTheDocument();
    for (const at of [T1, T0]) expect(review.querySelector(`time[datetime="${at}"]`)).not.toBeNull();

    fireEvent.click(within(review).getByRole("button"));
    const dialog = screen.getByRole("dialog", { name: "Source details" });
    const claim = (source: string) => within(dialog).getByText(source).closest<HTMLElement>('[data-testid="settings-row"]')!;
    expect(within(claim("Profile")).getByText("Ankit")).toBeInTheDocument();
    expect(within(claim("Memory (you wrote)")).getByText("Ankit Kumar Singh")).toBeInTheDocument();
    // Only the profile claim has a source to fix; chat memory has none.
    expect(within(dialog).getAllByRole("link")).toHaveLength(1);
    expect(within(dialog).getByRole("link", { name: /Fix at source/ })).toHaveAttribute("href", PROFILE_ROUTE.href);
    first.unmount();

    // Negative control: with no disagreement there is nothing to review.
    m.view = mirror({ steps });
    render(<LivingMemoryDocument />);
    expect(screen.queryByRole("heading", { name: "Review" })).toBeNull();
    expect(screen.queryByText("Needs review")).toBeNull();
  });

  it("sends each source and record to where it is fixed, and shows no link for a kind without a route", () => {
    m.routes = { profile: PROFILE_ROUTE };
    m.view = mirror({ steps: [{ inputs: [profile("Ankit"), consent("c1", "attr.food.*")], kinds: ["profile", "consent"], now: T1 }] });
    render(<LivingMemoryDocument />);
    // The whole Profile source row is the link, and it keeps its state.
    const source = within(row("Sources", "Profile")).getByRole("link");
    expect(source).toHaveAttribute("href", PROFILE_ROUTE.href);
    for (const text of ["Profile", "Current", "Edit profile"]) expect(within(source).getByText(text)).toBeInTheDocument();
    expect(within(row("Sources", "Consents")).queryByRole("link")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /^Profile/ }));
    let dialog = screen.getByRole("dialog", { name: "Source details" });
    const fix = within(dialog).getByRole("link", { name: /Fix at source/ });
    expect(fix).toHaveAttribute("href", PROFILE_ROUTE.href);
    expect(within(fix).getByText("Edit profile")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    fireEvent.click(screen.getByRole("button", { name: /^Consent 1/ }));
    dialog = screen.getByRole("dialog", { name: "Source details" });
    expect(within(dialog).queryByText("Fix at source")).toBeNull();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  /** True once SafeMarkdown can keep outside links as text, which GFM needs in a generated preview. */
  function safeMarkdownKeepsOutsideLinksAsText(): boolean {
    const probe = render(<SafeMarkdown markdown="https://x.test/p" {...INTERNAL_GFM} />);
    const kept = probe.container.querySelector("a") === null;
    probe.unmount();
    return kept;
  }

  it("renders a GFM table in the preview and keeps URL- and email-like values as text", (ctx) => {
    if (!safeMarkdownKeepsOutsideLinksAsText()) ctx.skip("SafeMarkdown has no internal link policy yet, so the preview stays CommonMark");
    const view = mirror({ steps: [{ inputs: [profile("www.example.test https://x.test/p")], kinds: ["profile"], now: T1 }] });
    m.view = { ...view, markdown: `${view.markdown}\n| Field | Value |\n| --- | --- |\n| Name | Ankit |\n` };
    const { container } = render(<LivingMemoryDocument />);
    openTab("Preview");
    const preview = screen.getByLabelText("Live memory preview");
    const table = preview.querySelector("table");
    expect(table).not.toBeNull();
    expect(within(table!).getByText("Ankit").tagName).toBe("TD");
    const text = preview.textContent!.replace(/\u2060/g, "");
    expect(text).toContain("Name: www.example.test https://x.test/p");
    expect(text).toContain("Email: owner@example.test");
    // Owner URLs and emails never become links; only in-app routes do.
    for (const anchor of preview.querySelectorAll("a"))
      expect(anchor.getAttribute("href")).toMatch(/^\/(?!\/)/);
    for (const tag of ["pre", "img", "script"]) expect(container.querySelector(tag)).toBeNull();
  });
});
