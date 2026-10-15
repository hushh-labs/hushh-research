import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneAgentProfileSheet } from "@/components/agent/one-agent-profile-sheet";
import { useOneDisplayName } from "@/lib/agent/use-one-display-name";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import {
  LIVE_MEMORY_BOUNDARY_COPY,
  type LiveMirrorFact,
  type LiveMirrorOverall,
  type LiveMirrorView,
} from "@/lib/pkm/live-mirror-contract";
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
  getIdToken: vi.fn().mockResolvedValue("viewer-token"),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: mocks.uid, getIdToken: mocks.getIdToken } }),
}));
vi.mock("@/lib/pkm/memory-refresh", () => ({
  peekLiveMirror: (uid: string) => mocks.peekLiveMirror(uid),
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

const T = "2026-10-15T10:00:00.000Z";
function mirrorFact(predicate: string, label: string, value: LiveMirrorFact["value"], patch: Partial<LiveMirrorFact> = {}): LiveMirrorFact {
  const [kind, field] = predicate.split(".") as [LiveMirrorFact["kind"], string];
  return { key: predicate, predicate, kind, sourceId: "owner-record", ref: kind === "profile" ? "Profile" : "Consent 2",
    field, label, value, state: "verified", revision: 2, sourceUpdatedAt: T, capturedAt: T, verifiedAt: T, ...patch };
}
function mirrorView(ownerId: string, patch: Partial<LiveMirrorView> = {}): LiveMirrorView {
  return {
    schemaVersion: "live_mirror.v1", ownerId, vaultEpoch: mocks.epoch, builtAt: T, inventoryObservedAt: T,
    inventoryComplete: true, issues: [], nameConflict: false, sources: [], markdown: "",
    facts: [mirrorFact("profile.name", "Name", "SYNTHETIC_A"), mirrorFact("profile.email", "Email", "a@example.test")],
    history: { entries: [], firstRetainedSequence: 1, droppedCount: 0, truncatedAt: null, coverage: "open_app_only" },
    evaluatedAt: "2026-10-15T10:00:30.000Z", overall: "current", lastVerifiedAt: T, ...patch,
  };
}
const openProfileTab = () =>
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Profile" }), { button: 0, ctrlKey: false });
const mirrorStatus = () => within(screen.getByTestId("live-mirror-status"));

describe("One agent profile feed preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uid = "viewer";
    mocks.epoch = 0;
    mocks.peekLiveMirror.mockReset().mockReturnValue(null);
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
    expect(mirrorStatus().getByText("Up to date")).toBeInTheDocument();
    expect(screen.getByText(/^Checked /)).toBeInTheDocument();
    expect(screen.getByText("Updates while the app is open and unlocked.")).toBe(screen.getByText(LIVE_MEMORY_BOUNDARY_COPY));
    const name = screen.getByText("Name").closest<HTMLElement>('[data-testid="live-mirror-fact"]')!;
    expect(within(name).getByText("SYNTHETIC_A")).toBeInTheDocument();
    expect(screen.getByText("a@example.test")).toBeInTheDocument();
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

  it.each<[LiveMirrorOverall, string]>([
    ["current", "Up to date"],
    ["updating", "Updating"],
    ["stale", "May be out of date"],
    ["partial", "Some sources unavailable"],
    ["conflict", "Needs your review"],
    ["empty", "Nothing yet"],
  ])("names the %s mirror state in plain words", async (overall, label) => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, { overall }));
    render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    expect(await screen.findByTestId("live-mirror-status")).toHaveTextContent(label);
  });

  it("badges facts that are not current and never shows a disputed or removed value", async () => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, { overall: "conflict", facts: [
      mirrorFact("profile.name", "Name", "SYNTHETIC_A", { state: "stale" }),
      // A projection fault that leaves values on these must still not show them.
      mirrorFact("profile.email", "Email", "CONFLICT_VALUE_X", { state: "conflicted" }),
      mirrorFact("consent.scope", "Scope", "DELETED_VALUE_X", { state: "deleted", sourceUpdatedAt: "2026-10-15T11:00:00.000Z" }),
      mirrorFact("consent.status", "Status", "Active", { state: "unavailable" }),
      mirrorFact("consent.expiresAt", "Expires", "never", { sourceUpdatedAt: "2026-10-15T09:00:00.000Z" }),
    ] }));
    render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();

    const name = (await screen.findByText("Name")).closest<HTMLElement>('[data-testid="live-mirror-fact"]')!;
    expect(within(name).getByText("SYNTHETIC_A")).toBeInTheDocument();
    expect(within(name).getByText("May be old")).toBeInTheDocument();
    const email = screen.getByText("Email").closest<HTMLElement>('[data-testid="live-mirror-fact"]')!;
    expect(within(email).getByText("Needs review")).toBeInTheDocument();
    expect(screen.queryByText("CONFLICT_VALUE_X")).toBeNull();
    expect(screen.queryByText("DELETED_VALUE_X")).toBeNull();
    // Up to three rows: name, email, then the newest verified record.
    expect(screen.getAllByTestId("live-mirror-fact")).toHaveLength(3);
    expect(screen.getByText("Consents · Expires")).toBeInTheDocument();
  });

  it("badges a last-known value it cannot check now and drops a removed profile row", async () => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, { overall: "partial", facts: [
      mirrorFact("profile.name", "Name", "SYNTHETIC_A", { state: "unavailable" }),
      mirrorFact("profile.email", "Email", "DELETED_VALUE_X", { state: "deleted" }),
    ] }));
    render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    const name = (await screen.findByText("Name")).closest<HTMLElement>('[data-testid="live-mirror-fact"]')!;
    expect(within(name).getByText("Can't check now")).toBeInTheDocument();
    expect(screen.queryByText("Email")).toBeNull();
    expect(screen.queryByText("DELETED_VALUE_X")).toBeNull();
  });

  it("clears owner A's preview on account switch and lock, and ignores a projection filed under another owner", async () => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid));
    const view = render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    expect(await screen.findByText("SYNTHETIC_A")).toBeInTheDocument();

    mocks.uid = "owner-b";
    mocks.epoch += 1;
    mocks.peekLiveMirror.mockImplementation((uid: string) =>
      mirrorView(uid, { facts: [mirrorFact("profile.name", "Name", "SYNTHETIC_B")] }));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(screen.queryByText("SYNTHETIC_A")).toBeNull();
    expect(screen.getByText("SYNTHETIC_B")).toBeInTheDocument();
    expect(mocks.peekLiveMirror).toHaveBeenLastCalledWith("owner-b");

    mocks.unlocked = false;
    mocks.epoch += 1;
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(mirrorStatus().getByText("Unlock to see memory")).toBeInTheDocument();
    expect(screen.queryByText("SYNTHETIC_B")).toBeNull();
    expect(screen.queryByText(LIVE_MEMORY_BOUNDARY_COPY)).toBeNull();
    expect(screen.queryByTestId("live-mirror-fact")).toBeNull();
    expect(screen.queryByRole("link", { name: "See all" })).toBeNull();

    // Negative controls: owner A's projection returned for owner B, or one
    // from an earlier vault epoch, renders no facts.
    mocks.unlocked = true;
    mocks.peekLiveMirror.mockImplementation(() => mirrorView("viewer"));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(mirrorStatus().getByText("Getting your memory")).toBeInTheDocument();
    expect(screen.queryByText("SYNTHETIC_A")).toBeNull();
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, { vaultEpoch: mocks.epoch - 1 }));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(screen.queryByTestId("live-mirror-fact")).toBeNull();
  });
});
