import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneAgentProfileSheet } from "@/components/agent/one-agent-profile-sheet";
import { useOneDisplayName } from "@/lib/agent/use-one-display-name";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import { LIVE_MEMORY_BOUNDARY_COPY, type LiveMirrorConflict, type LiveMirrorView } from "@/lib/pkm/live-mirror-contract";
import { applyLiveMirrorReadTime, buildLiveMirrorProjection } from "@/lib/pkm/live-mirror-projection";
import {
  appendVerifiedLivingSourceChanges,
  reconcileLivingSources,
  type LivingSourceHistory,
  type LivingSourceInput,
  type LivingSourceInventory,
} from "@/lib/pkm/living-source-records";
import { CacheService } from "@/lib/services/cache-service";

const mocks = vi.hoisted(() => ({
  uid: "viewer",
  epoch: 0,
  unlocked: true,
  identityOwner: "viewer",
  preferredName: "Love",
  revision: 0,
  refresh: vi.fn(),
  list: vi.fn(),
  markRead: vi.fn(),
  push: vi.fn(),
  close: vi.fn(),
  peekLiveMirror: vi.fn(),
  route: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("viewer-token"),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: mocks.uid, getIdToken: mocks.getIdToken } }),
}));
vi.mock("@/lib/pkm/memory-refresh", () => ({
  peekLiveMirror: (uid: string) => mocks.peekLiveMirror(uid),
}));
vi.mock("@/lib/pkm/live-mirror-presentation", async (original) => ({
  ...(await original<typeof import("@/lib/pkm/live-mirror-presentation")>()),
  liveMirrorSourceRoute: (kind: string) => mocks.route(kind),
}));
vi.mock("@/lib/vault/session-epoch", async (original) => ({
  ...(await original<typeof import("@/lib/vault/session-epoch")>()),
  snapshotVaultSessionEpoch: () => mocks.epoch,
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: mocks.unlocked, vaultKey: mocks.unlocked ? "fixture-key" : null, vaultOwnerToken: mocks.unlocked ? "fixture-token" : null }),
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  usePkmDomainResource: () => ({ refresh: mocks.refresh, data: { key: { userId: mocks.identityOwner }, data: { communication_preferences: { preferred_name: mocks.preferredName } } } }),
}));
vi.mock("@/lib/pkm/use-pkm-domain-change-revision", () => ({ usePkmDomainChangeRevision: () => mocks.revision }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/services/feed-service", () => ({
  FeedService: { list: mocks.list, markRead: mocks.markRead },
}));
vi.mock("@/lib/connected-systems/crm-product-availability", () => ({
  isLocalCrmBuildEnabled: () => false,
}));

const item = (id: string, event_type: string) => ({
  id,
  event_type,
  source_domain: "connected_systems",
  actor_label: null,
  metadata: {},
  read: false,
  created_at: "2026-10-12T08:00:00Z",
});

const T0 = "2026-10-15T09:58:00.000Z";
const T = "2026-10-15T10:00:00.000Z";
const READ = "2026-10-15T10:00:30.000Z";
type Step = { inputs: LivingSourceInput[]; kinds: string[]; unavailable?: string[]; now: string };
const person = (ownerId: string, name: string, email: string | null = "a@example.test"): LivingSourceInput => ({
  kind: "profile", id: ownerId, createdAt: null, updatedAt: T0, value: { name, email },
});
const earning = (id: string, updatedAt: string, grossCents: number): LivingSourceInput => ({
  kind: "document_earning", id, createdAt: updatedAt, updatedAt,
  value: { stripeMode: "test", status: "succeeded", grossCents, netCents: grossCents - 30, createdAt: updatedAt },
});
/** A view built through the real reconciler, history, projection and read time. */
function mirrorView(ownerId: string, options: {
  steps?: Step[];
  readAt?: string;
  epoch?: number;
  inventory?: (inventory: LivingSourceInventory) => LivingSourceInventory;
} = {}): LiveMirrorView {
  let inventory: LivingSourceInventory | null = null;
  let history: LivingSourceHistory | null = null;
  for (const step of options.steps ?? [{ inputs: [person(ownerId, "SYNTHETIC_A")], kinds: ["profile"], now: T }]) {
    const next = reconcileLivingSources(inventory, step.inputs, step.kinds, step.unavailable ?? [], step.now);
    history = appendVerifiedLivingSourceChanges(history, inventory, next);
    inventory = next;
  }
  const projection = buildLiveMirrorProjection({
    ownerId, vaultEpoch: options.epoch ?? mocks.epoch, now: T, history, document: null,
    inventory: inventory && options.inventory ? options.inventory(inventory) : inventory,
  });
  return applyLiveMirrorReadTime(projection, options.readAt ?? READ, "current");
}
const rowTitle = (row: HTMLElement) => row.querySelector('[data-slot="settings-row-title"]')?.textContent;
const factRow = (title: string) => screen.getAllByTestId("live-mirror-fact").find(row => rowTitle(row) === title)!;
const claim = (source: LiveMirrorConflict["claims"][number]["source"], label: string, value: string): LiveMirrorConflict["claims"][number] =>
  ({ source, label, value, revision: 1, sourceUpdatedAt: T0, verifiedAt: null });
const openProfileTab = () =>
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Profile" }), { button: 0, ctrlKey: false });
const mirrorStatus = () => within(screen.getByTestId("live-mirror-status"));

describe("One agent profile feed preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uid = "viewer";
    mocks.epoch = 0;
    mocks.peekLiveMirror.mockReset().mockReturnValue(null);
    mocks.route.mockReset().mockReturnValue(null);
    mocks.revision = 0;
    mocks.refresh.mockResolvedValue(null);
    mocks.unlocked = true;
    mocks.identityOwner = "viewer";
    mocks.preferredName = "Love";
    window.localStorage.clear();
    CacheService.getInstance().clear();
    mocks.list.mockResolvedValue({
      items: [
        item("1", "calendar_connected"),
        item("2", "mail_connected"),
        item("3", "connected_systems_connected"),
      ],
      next_cursor: null,
      unread_count: 3,
    });
  });

  it("updates the header name and clears it on lock or owner mismatch", () => {
    const { result, rerender } = renderHook(() => useOneDisplayName());
    expect(result.current).toBe("Love");
    mocks.preferredName = "Roopmann";
    mocks.revision = 1;
    rerender();
    expect(result.current).toBe("Roopmann");
    expect(mocks.refresh).toHaveBeenCalledWith({ force: true });
    mocks.identityOwner = "another-owner";
    rerender();
    expect(result.current).toBe("One");
    mocks.identityOwner = "viewer";
    mocks.refresh.mockClear();
    mocks.unlocked = false;
    rerender();
    expect(result.current).toBe("One");
    expect(mocks.refresh).not.toHaveBeenCalled();
    mocks.unlocked = true;
    mocks.preferredName = "";
    rerender();
    expect(result.current).toBe("One");
  });

  it("shows only the unlocked current owner's preferred name", async () => {
    const view = render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(screen.getByRole("heading", { name: "Love" })).toBeInTheDocument();
    mocks.identityOwner = "another-owner";
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(screen.getByRole("heading", { name: "One" })).toBeInTheDocument();
    mocks.identityOwner = "viewer";
    mocks.unlocked = false;
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(screen.getByRole("heading", { name: "One" })).toBeInTheDocument();
  });

  it("fetches the viewer's feed only when visible and preserves its clear/read boundaries", async () => {
    window.localStorage.setItem("hushh:feed-cleared-through-id:viewer", "1");
    const view = render(
      <OneAgentProfileSheet open={false} onOpenChange={mocks.close} />,
    );
    expect(mocks.list).not.toHaveBeenCalled();
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    await screen.findByText("Mail connected");
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        idToken: "viewer-token",
        userId: "viewer",
        limit: 20,
      }),
    );
    expect(screen.queryByText("Calendar connected")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("feed-row")).toHaveLength(1);
    expect(mocks.markRead).not.toHaveBeenCalled();

    openProfileTab();
    const memory = await screen.findByRole("link", { name: "Open Memory" });
    expect(memory).toHaveAttribute("href", "/one/pkm");
    const calls = mocks.list.mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls));
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("does not reintroduce cleared consent entries through a newer bundle row", async () => {
    window.localStorage.setItem("hushh:feed-cleared-through-id:viewer", "3");
    mocks.list.mockResolvedValue({
      items: [
        {
          ...item("5", "consent_granted"),
          source_domain: "consent",
          metadata: {
            bundle_id: "same-request",
            scope_description: "Recent detail",
          },
        },
        {
          ...item("1", "consent_granted"),
          source_domain: "consent",
          metadata: {
            bundle_id: "same-request",
            scope_description: "Cleared detail",
          },
        },
      ],
      next_cursor: null,
      unread_count: 2,
    });
    render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    await screen.findByText(/Recent detail/);
    expect(screen.queryByText(/Cleared detail/)).not.toBeInTheDocument();
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("shows the shared live memory preview instead of static file cards, and closes before navigating", async () => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid));
    render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();

    expect(await screen.findByRole("heading", { name: "Live memory" })).toBeInTheDocument();
    expect(mirrorStatus().getByRole("status")).toHaveTextContent("Up to date");
    expect(mirrorStatus().getByText("Checked just now")).toBeInTheDocument();
    expect(screen.getByText(LIVE_MEMORY_BOUNDARY_COPY)).toBeInTheDocument();
    expect(within(factRow("Name")).getByText("SYNTHETIC_A")).toBeInTheDocument();
    expect(within(factRow("Email")).getByText("a@example.test")).toBeInTheDocument();
    const seeAll = screen.getByRole("link", { name: "See all" });
    expect(seeAll).toHaveAttribute("href", buildProfileRoute({ panel: "my-data" }));
    expect(seeAll).toHaveAttribute("href", "/one/profile/my-data");
    expect(screen.getByRole("link", { name: "Open Memory" })).toHaveAttribute("href", "/one/pkm");
    expect(screen.queryByLabelText("soul.md preview")).toBeNull();
    expect(screen.queryByText("Soul preview")).toBeNull();
    // jsdom cannot follow a link; cancel the browser default, keep the handler.
    seeAll.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(seeAll);
    expect(mocks.close).toHaveBeenCalledWith(false);
  });

  it("picks the name, the email, then the newest record, summarised", async () => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, { steps: [{ inputs: [
      person(uid, "SYNTHETIC_A"),
      { kind: "consent", id: "c1", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
        value: { scope: "attr.food.*", status: "active" } },
      earning("e-old", "2026-10-01T00:00:00.000Z", 500),
      earning("e-new", "2026-10-14T00:00:00.000Z", 1_200),
    ], kinds: ["profile", "consent", "document_earning"], now: T }] }));
    render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    await screen.findByTestId("live-mirror-status");
    expect(screen.getAllByTestId("live-mirror-fact").map(row => row.querySelector('[data-slot="settings-row-title"]')?.textContent))
      .toEqual(["Name", "Email", "Earning 2"]);
    expect(within(factRow("Earning 2")).getByText("Gross: $12.00 · Net: $11.70 · Status: Paid")).toBeInTheDocument();
  });

  it("badges a value it cannot check now or that may be old, and drops a removed field", async () => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, { steps: [
      { inputs: [person(uid, "SYNTHETIC_A", "REMOVED_EMAIL_X")], kinds: ["profile"], now: T0 },
      { inputs: [person(uid, "SYNTHETIC_A", null)], kinds: ["profile"], now: T },
      { inputs: [], kinds: [], unavailable: ["profile"], now: T },
    ] }));
    const view = render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    await screen.findByTestId("live-mirror-status");
    expect(mirrorStatus().getByRole("status")).toHaveTextContent("Some sources unavailable");
    expect(within(factRow("Name")).getByText("SYNTHETIC_A")).toBeInTheDocument();
    expect(within(factRow("Name")).getByText("Can’t check now")).toBeInTheDocument();
    expect(screen.getAllByTestId("live-mirror-fact")).toHaveLength(1);
    // The sheet renders in a portal, so check the whole document.
    expect(document.body.textContent).not.toContain("REMOVED_EMAIL_X");

    // Read past the freshness window, the same verified name may be old.
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, { readAt: "2026-10-15T10:08:00.000Z" }));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(within(factRow("Name")).getByText("May be old")).toBeInTheDocument();
  });

  it("never shows a disputed or removed value", async () => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, {
      steps: [
        { inputs: [person(uid, "SYNTHETIC_A"), earning("e1", T0, 4_242)], kinds: ["profile", "document_earning"], now: T0 },
        { inputs: [person(uid, "SYNTHETIC_A")], kinds: ["profile", "document_earning"], now: T },
      ],
      // Two disagreeing versions of the profile at the same revision.
      inventory: inventory => ({ ...inventory, records: inventory.records.flatMap(record => record.kind === "profile"
        ? [record, { ...record, value: { ...record.value, name: "CONFLICT_VALUE_X" } }] : [record]) }),
    }));
    render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    await screen.findByTestId("live-mirror-status");
    expect(mirrorStatus().getByRole("status")).toHaveTextContent("Needs your review");
    expect(within(factRow("Name")).getByText("Needs review")).toBeInTheDocument();
    expect(factRow("Name").querySelector('[data-slot="settings-row-description"]')).toBeNull();
    for (const hidden of ["SYNTHETIC_A", "CONFLICT_VALUE_X", "$42.42", "Earning"]) expect(document.body.textContent).not.toContain(hidden);
  });

  it("clears owner A's preview on account switch and lock, and ignores a projection filed under another owner", async () => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid));
    const view = render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    expect(await screen.findByText("SYNTHETIC_A")).toBeInTheDocument();

    mocks.uid = "owner-b";
    mocks.epoch += 1;
    mocks.peekLiveMirror.mockImplementation((uid: string) =>
      mirrorView(uid, { steps: [{ inputs: [person(uid, "SYNTHETIC_B")], kinds: ["profile"], now: T }] }));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(screen.queryByText("SYNTHETIC_A")).toBeNull();
    expect(screen.getByText("SYNTHETIC_B")).toBeInTheDocument();
    expect(mocks.peekLiveMirror).toHaveBeenLastCalledWith("owner-b");

    mocks.unlocked = false;
    mocks.epoch += 1;
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(mirrorStatus().getByRole("status")).toHaveTextContent("Memory locked");
    expect(mirrorStatus().getByText("Unlock to see it")).toBeInTheDocument();
    expect(screen.queryByText("SYNTHETIC_B")).toBeNull();
    expect(screen.queryByText(LIVE_MEMORY_BOUNDARY_COPY)).toBeNull();
    expect(screen.queryByTestId("live-mirror-fact")).toBeNull();
    expect(screen.queryByRole("link", { name: "See all" })).toBeNull();

    // Negative controls: owner A's projection returned for owner B, or one
    // from an earlier vault epoch, renders no facts.
    mocks.unlocked = true;
    mocks.peekLiveMirror.mockImplementation(() => mirrorView("viewer"));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(mirrorStatus().getByRole("status")).toHaveTextContent("Checking sources");
    expect(screen.queryByText("SYNTHETIC_A")).toBeNull();
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, { epoch: mocks.epoch - 1 }));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(screen.queryByTestId("live-mirror-fact")).toBeNull();
  });

  it("shows both claims of a disagreement above the facts and routes one fix to that source", async () => {
    const nameConflict: LiveMirrorConflict = { predicate: "profile.name", label: "Name",
      claims: [claim("soul", "Memory", "SYNTHETIC_SOUL_NAME"), claim("profile", "Profile", "SYNTHETIC_A")] };
    mocks.route.mockImplementation((kind: string) => kind === "profile" ? { href: "/one/profile/account", label: "Account" } : null);
    mocks.peekLiveMirror.mockImplementation((uid: string) => ({ ...mirrorView(uid), overall: "conflict" as const, conflicts: [nameConflict] }));
    const view = render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    await screen.findByTestId("live-mirror-status");
    // The headline and its line are Profile's, from the shared presentation module.
    expect(mirrorStatus().getByRole("status")).toHaveTextContent("Needs your review");
    expect(mirrorStatus().getByText("Two sources disagree")).toBeInTheDocument();
    const conflict = screen.getByTestId("live-mirror-conflict");
    expect(rowTitle(conflict)).toBe("Name");
    expect(within(conflict).getByText("Memory: SYNTHETIC_SOUL_NAME · Profile: SYNTHETIC_A")).toBeInTheDocument();
    expect(within(conflict).getByText("Needs review")).toBeInTheDocument();
    // Above the facts, and the disputed name is not repeated as a plain fact row.
    expect(screen.getAllByTestId(/^live-mirror-(conflict|fact)$/).map(row => row.dataset.testid))
      .toEqual(["live-mirror-conflict", "live-mirror-fact"]);
    expect(screen.getAllByTestId("live-mirror-fact").map(rowTitle)).toEqual(["Email"]);
    const preview = within(screen.getByRole("region", { name: "Live memory preview" }));
    const fix = preview.getByRole("link", { name: /^Fix at source/ });
    expect(fix).toHaveAttribute("href", "/one/profile/account");
    expect(within(fix).getByText("Account")).toBeInTheDocument();
    expect(mocks.route).toHaveBeenCalledWith("profile");
    // One extra action only.
    expect(preview.getAllByRole("link").map(link => link.textContent)).toEqual(["See all", expect.stringContaining("Fix at source"), "Open Memory"]);
    fix.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(fix);
    expect(mocks.close).toHaveBeenCalledWith(false);

    // The first conflict's source wins over the first fact's.
    const statusConflict: LiveMirrorConflict = { predicate: "consent.status", label: "Status",
      claims: [claim("consent", "Consents", "active"), claim("consent", "Consents", "revoked")] };
    mocks.route.mockImplementation((kind: string) => kind === "consent"
      ? { href: "/one/consent", label: "Consents" } : { href: "/one/profile/account", label: "Account" });
    mocks.peekLiveMirror.mockImplementation((uid: string) => ({ ...mirrorView(uid), overall: "conflict" as const, conflicts: [statusConflict] }));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(preview.getByRole("link", { name: /^Fix at source/ })).toHaveAttribute("href", "/one/consent");
    expect(within(screen.getByTestId("live-mirror-conflict")).getByText("Consents: Active · Consents: Revoked")).toBeInTheDocument();
    expect(screen.getAllByTestId("live-mirror-fact").map(rowTitle)).toEqual(["Name", "Email"]);

    // Negative controls: without conflicts there is no conflict row and the
    // name is a plain fact; without a route there is no fix link.
    mocks.route.mockReturnValue(null);
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(screen.queryByTestId("live-mirror-conflict")).toBeNull();
    expect(preview.queryByRole("link", { name: /^Fix at source/ })).toBeNull();
    expect(within(factRow("Name")).getByText("SYNTHETIC_A")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("SYNTHETIC_SOUL_NAME");
  });
});
