import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneAgentProfileSheet } from "@/components/agent/one-agent-profile-sheet";
import { useOneDisplayName } from "@/lib/agent/use-one-display-name";
import { reduceChatOnboarding, type ChatOnboardingState } from "@/lib/agent/chat-onboarding/chat-onboarding-machine";
import type { ChatOnboardingChipId } from "@/lib/agent/chat-onboarding/chat-onboarding-script";
import { useChatOnboardingSession } from "@/lib/agent/chat-onboarding/chat-onboarding-session";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import { LIVE_MEMORY_BOUNDARY_COPY, type LiveMirrorClaim, type LiveMirrorView } from "@/lib/pkm/live-mirror-contract";
import {
  applyLiveMirrorReadTime,
  buildLiveMirrorProjection,
  type BuildLiveMirrorProjectionParams,
} from "@/lib/pkm/live-mirror-projection";
import { formatLiveMirrorDateTime, formatLiveMirrorValue, liveMirrorSourceRoute } from "@/lib/pkm/live-mirror-presentation";
import {
  appendVerifiedLivingSourceChanges,
  reconcileLivingSources,
  type LivingSourceHistory,
  type LivingSourceInput,
  type LivingSourceInventory,
} from "@/lib/pkm/living-source-records";
import { CacheService } from "@/lib/services/cache-service";
import { buildTodo } from "@/lib/services/todo-list-pkm-service";

const mocks = vi.hoisted(() => ({
  uid: "viewer",
  epoch: 0,
  unlocked: true,
  identityOwner: "viewer",
  preferredName: "Love",
  native: false,
  identityReady: true,
  rereading: false,
  revision: 0,
  refresh: vi.fn(),
  list: vi.fn(),
  markRead: vi.fn(),
  push: vi.fn(),
  close: vi.fn(),
  peekLiveMirror: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("viewer-token"),
  loadTasks: vi.fn(),
}));
vi.mock("@/lib/todos/use-todo-capability-sources", () => ({ useTodoCapabilitySources: () => ({ reads: [], loading: false, error: false, refresh: vi.fn() }) }));
vi.mock("@/lib/capacitor/native-drawers", () => ({ nativeDrawersPlatformEligible: () => mocks.native }));
vi.mock("@/components/app-ui/native-feature-page", () => ({
  NativeFeaturePage: ({ open, context, children, onBack, onClose }: { open: boolean; context: string; children: React.ReactNode; onBack: () => void; onClose: () => void }) =>
    open ? <section data-testid="native-one-pane" data-context={context}><button onClick={onBack}>Back to Chat</button><button onClick={onClose}>Close One profile</button>{children}</section> : null,
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
  usePkmDomainResource: () => ({
    refresh: mocks.refresh,
    invalidated: mocks.rereading,
    data: mocks.identityReady ? { key: { userId: mocks.identityOwner }, data: { communication_preferences: { preferred_name: mocks.preferredName } } } : null,
  }),
}));
vi.mock("@/lib/pkm/use-pkm-domain-change-revision", () => ({ usePkmDomainChangeRevision: () => mocks.revision }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }), usePathname: () => "/one" }));
vi.mock("@/lib/services/feed-service", () => ({
  FeedService: { list: mocks.list, markRead: mocks.markRead },
}));
vi.mock("@/lib/connected-systems/crm-product-availability", () => ({
  isLocalCrmBuildEnabled: () => false,
}));

vi.mock("@/lib/services/todo-list-pkm-service", async original => {
  const actual = await original();
  return { ...actual, TodoListPkmService: { ...actual.TodoListPkmService, load: mocks.loadTasks,
    setStatus: vi.fn().mockResolvedValue({ success: true }), remove: vi.fn().mockResolvedValue({ success: true }) } };
});
vi.mock("@/lib/feed/use-feed-actionables", () => ({ useFeedActionables: () => ({ actionables: [], loading: false, retry: vi.fn() }) }));
vi.mock("@/lib/feed/use-feed-briefing", () => ({ useFeedBriefing: () => ({ pendingKyc: null, kycLoading: false, retryKyc: vi.fn() }) }));
vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({ useCalendarConnectionStatus: () => ({ connected: false, loaded: true, refresh: vi.fn() }) }));
vi.mock("@/lib/calendar/use-calendar-upcoming-events", () => ({ useCalendarUpcomingEvents: () => ({ events: [], loaded: true, refresh: vi.fn() }) }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    status: { connected: true, google_email: "test@example.com" },
  }),
}));
vi.mock("@/lib/services/private-text-approval-service", () => ({ PrivateTextApprovalService: { get: async () => null } }));

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
/** Five minutes after the build: a later read of the same view, still inside its freshness window. */
const READ_LATER = "2026-10-15T10:05:00.000Z";
type Step = { inputs: LivingSourceInput[]; kinds: string[]; unavailable?: string[]; now: string };
const person = (ownerId: string, name: string, email: string | null = "a@example.test"): LivingSourceInput => ({
  kind: "profile", id: ownerId, createdAt: null, updatedAt: T0, value: { name, email },
});
const earning = (id: string, updatedAt: string, grossCents: number): LivingSourceInput => ({
  kind: "document_earning", id, createdAt: updatedAt, updatedAt,
  value: { stripeMode: "test", status: "succeeded", grossCents, netCents: grossCents - 30, createdAt: updatedAt },
});
/** A paid document request in euros, last changed at T0. */
const payment = (id: string, amountCents: number): LivingSourceInput => ({
  kind: "document_request_payment", id, createdAt: T0, updatedAt: T0,
  value: { mode: "live", status: "paid", amountCents, currency: "EUR", paidAt: T0 },
});
/** A second copy of each payment at the same revision, changed later, that disagrees on the amount. */
const disagreeingPaymentCopy = (inventory: LivingSourceInventory): LivingSourceInventory => ({
  ...inventory,
  records: inventory.records.flatMap(record => record.kind === "document_request_payment"
    ? [record, { ...record, updatedAt: T, value: { ...record.value, amountCents: 5_678 } }] : [record]),
});
/** memory.md, at revision 9, names the owner "Ankit K" while the verified profile says "Ankit Kumar". */
const NAME_CONFLICT: Partial<BuildLiveMirrorProjectionParams> = {
  document: { markdown: "", complete: true, sourceLinks: [], excludedDomains: [], freshness: [
    { domain: "one_memory", title: "Identity facts", status: "conflicted", contentRevision: 9, updatedAt: T0, cardCount: 1 },
  ] },
  nameConflict: true,
  nameClaims: { soul: ["Ankit K"], profile: "Ankit Kumar" },
};
const euros = (cents: number) => formatLiveMirrorValue("document_request_payment.amountCents", cents, { currency: "EUR" });
/** A view built through the real reconciler, history, projection and read time. */
function mirrorView(ownerId: string, options: {
  steps?: Step[];
  readAt?: string;
  epoch?: number;
  inventory?: (inventory: LivingSourceInventory) => LivingSourceInventory;
  /** Further projection inputs, such as the memory document and a name conflict's sides. */
  extra?: Partial<BuildLiveMirrorProjectionParams>;
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
    ...options.extra,
  });
  return applyLiveMirrorReadTime(projection, options.readAt ?? READ, "current");
}
const rowTitle = (row: HTMLElement) => row.querySelector('[data-slot="settings-row-title"]')?.textContent;
const factRow = (title: string) => screen.getAllByTestId("live-mirror-fact").find(row => rowTitle(row) === title)!;
/** The real onboarding reducer, so these states follow the machine's own contract. */
function onboardingAfter(...chips: ChatOnboardingChipId[]): ChatOnboardingState {
  let state = reduceChatOnboarding(null, { type: "start", displayName: "Kay", firstName: "Kay", anchor: null }).state;
  for (const chipId of chips) {
    state = reduceChatOnboarding(state, { type: "chip", chipId, anchor: null, today: "2026-10-16", firstName: "Kay" }).state;
  }
  return state;
}
const PICKED = ["name_signin", "focus_email", "tone_casual"] as const;
const saveResult = (ok: boolean) =>
  reduceChatOnboarding(onboardingAfter(...PICKED, "save"), { type: "save_result", ok, anchor: null, today: "2026-10-16" }).state;
const session = () => useChatOnboardingSession.getState();

/** A row's supporting lines, one per claim. */
const lines = (row: HTMLElement) =>
  [...row.querySelectorAll('[data-slot="settings-row-description"] > span')].map(line => line.textContent);
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
    mocks.native = false;
    mocks.identityReady = true;
    mocks.rereading = false;
    useChatOnboardingSession.getState().reset(null);
    window.localStorage.clear();
    CacheService.getInstance().clear();
    mocks.loadTasks.mockResolvedValue({ tasks: [
      buildTodo({ id: "task-anytime", title: "Anytime task" }),
      buildTodo({ id: "task-dated", title: "Tomorrow task", date: "2099-01-01" }),
    ] });
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

  it("shows a name picked in onboarding at once and holds it while memory re-reads", () => {
    mocks.preferredName = "";
    const { result, rerender } = renderHook(() => useOneDisplayName());
    expect(result.current).toBe("One");

    // "Call me Kay" is only a session draft: memory holds nothing yet.
    act(() => {
      session().reset("viewer");
      session().patch({ machine: onboardingAfter("name_signin") });
    });
    expect(result.current).toBe("Kay");

    // Saved: the draft clears while memory is invalidated and read again.
    act(() => {
      mocks.identityReady = false;
      mocks.rereading = true;
      session().patch({ machine: saveResult(true) });
    });
    expect(result.current).toBe("Kay");

    mocks.identityReady = true;
    mocks.rereading = false;
    mocks.preferredName = "Kay";
    rerender();
    expect(result.current).toBe("Kay");

    // A later edit in Settings wins over anything onboarding left behind.
    mocks.preferredName = "Roopmann";
    rerender();
    expect(result.current).toBe("Roopmann");
  });

  it("never keeps a declined or unsaved pick, and shows one only to its unlocked owner", () => {
    mocks.preferredName = "";
    const { result, rerender } = renderHook(() => useOneDisplayName());
    const pick = (owner: string, machine: ChatOnboardingState) =>
      act(() => {
        session().reset(owner);
        session().patch({ machine });
      });

    pick("another-owner", onboardingAfter(...PICKED));
    expect(result.current).toBe("One");

    pick("viewer", onboardingAfter(...PICKED));
    expect(result.current).toBe("Kay");
    mocks.unlocked = false;
    rerender();
    expect(result.current).toBe("One");
    mocks.unlocked = true;
    rerender();
    expect(result.current).toBe("Kay");

    // Nothing was stored, so the label follows memory straight back.
    act(() => session().patch({ machine: saveResult(false) }));
    expect(result.current).toBe("One");
    act(() => session().patch({ machine: onboardingAfter(...PICKED, "dont_save") }));
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

  it("keeps native One on the shared hero and tabs without replacing the pane or leaking another owner's name", async () => {
    mocks.native = true;
    const view = render(<OneAgentProfileSheet open nativeReady onOpenChange={mocks.close} />);
    const pane = screen.getByTestId("native-one-pane");
    const binding = pane.dataset.context;
    expect(screen.getByRole("heading", { name: "Love" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Feed" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map(tab => tab.textContent?.trim())).toEqual(["Feed", "To-do", "Profile"]);
    await screen.findByText("Mail connected");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Profile" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("link", { name: "Open Memory" })).toHaveAttribute("href", "/one/pkm");
    expect(screen.getByRole("heading", { name: "Live memory" })).toBeInTheDocument();
    expect(screen.getByTestId("native-one-pane")).toBe(pane);
    expect(pane.dataset.context).toBe(binding);
    expect(mocks.markRead).not.toHaveBeenCalled();
    mocks.identityOwner = "another-owner";
    view.rerender(<OneAgentProfileSheet open nativeReady onOpenChange={mocks.close} />);
    expect(screen.queryByRole("heading", { name: "Love" })).toBeNull();
    expect(screen.getByRole("heading", { name: "One" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close One profile" }));
    expect(mocks.close).toHaveBeenCalledWith(false);
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

  it("shows a disputed value only as a claim under review and never shows a removed value", async () => {
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
    // Both disputed values appear only together, in the review row (A08), each
    // named by its copy and with no badge: the status line already says it.
    const conflict = screen.getByTestId("live-mirror-conflict");
    expect(within(conflict).queryByText("Needs review")).toBeNull();
    expect(lines(conflict).map(line => line?.split(" · ")[0])).toEqual(["Profile, copy 1: CONFLICT_VALUE_X", "Profile, copy 2: SYNTHETIC_A"]);
    const outsideReview = document.body.textContent!.replace(conflict.textContent!, "");
    for (const claim of ["SYNTHETIC_A", "CONFLICT_VALUE_X"]) expect(outsideReview).not.toContain(claim);
    // A removed record never shows anywhere.
    for (const removed of ["$42.42", "Earning"]) expect(document.body.textContent).not.toContain(removed);
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

  it("lists every side of each disagreement a line apiece and links once to each screen that fixes one", async () => {
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid, {
      steps: [{ inputs: [person(uid, "Ankit Kumar"), payment("p1", 1_234)], kinds: ["profile", "document_request_payment"], now: T }],
      inventory: disagreeingPaymentCopy,
      extra: NAME_CONFLICT,
      readAt: READ_LATER,
    }));
    const view = render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    await screen.findByTestId("live-mirror-status");
    // The headline and its line are Profile's, from the shared presentation module.
    expect(mirrorStatus().getByRole("status")).toHaveTextContent("Needs your review");
    expect(mirrorStatus().getByText("Some details disagree")).toBeInTheDocument();
    const [name, amount] = screen.getAllByTestId("live-mirror-conflict");
    expect([rowTitle(name!), rowTitle(amount!)]).toEqual(["Name", "Amount"]);
    // One claim per line, worded as on Profile, each with when it was checked or changed.
    // Checked at the build and read five minutes later: the check time follows the read.
    expect(lines(name!)).toEqual([
      `Your memory: Ankit K · Changed ${formatLiveMirrorDateTime(T0)} · Version 9`,
      "Profile: Ankit Kumar · Checked 5 min ago · Version 1",
    ]);
    // Money reads in each copy's own currency.
    expect([euros(1_234), euros(5_678)]).toEqual(["€12.34", "€56.78"]);
    expect(lines(amount!)).toEqual([
      `Document payment 1, copy 1: ${euros(1_234)} · Changed ${formatLiveMirrorDateTime(T0)} · Version 1`,
      `Document payment 1, copy 2: ${euros(5_678)} · Changed ${formatLiveMirrorDateTime(T)} · Version 1`,
    ]);
    // The status line says it once; conflict rows carry no badge, as on Profile.
    for (const conflict of [name!, amount!]) expect(within(conflict).queryByText("Needs review")).toBeNull();
    // Above the facts, and the disputed name is not repeated as a plain fact row.
    expect(screen.getAllByTestId(/^live-mirror-(conflict|fact)$/).map(row => row.dataset.testid))
      .toEqual(["live-mirror-conflict", "live-mirror-conflict", "live-mirror-fact"]);
    expect(screen.getAllByTestId("live-mirror-fact").map(rowTitle)).toEqual(["Email"]);
    // One fix row per screen that owns a disputed source, titled by where it goes.
    // memory.md has none: Open Memory is right below.
    const payments = liveMirrorSourceRoute("document_request_payment")!;
    const preview = within(screen.getByRole("region", { name: "Live memory preview" }));
    expect(preview.getAllByTestId("live-mirror-fix-at-source").map(row => within(row).getByRole("link").getAttribute("href")))
      .toEqual(["/one/profile/account", payments.href]);
    expect(preview.getAllByRole("link").map(link => link.textContent)).toEqual(["See all", "Edit profile", payments.label, "Open Memory"]);
    expect(preview.queryByText("Fix at source")).toBeNull();
    const fix = preview.getByRole("link", { name: "Edit profile" });
    fix.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(fix);
    expect(mocks.close).toHaveBeenCalledWith(false);

    // Negative controls: a healthy mirror has no conflict row and no fix row,
    // and the name is a plain fact again.
    mocks.peekLiveMirror.mockImplementation((uid: string) => mirrorView(uid));
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(screen.queryByTestId("live-mirror-conflict")).toBeNull();
    expect(preview.queryByTestId("live-mirror-fix-at-source")).toBeNull();
    expect(preview.getAllByRole("link").map(link => link.textContent)).toEqual(["See all", "Open Memory"]);
    expect(within(factRow("Name")).getByText("SYNTHETIC_A")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Ankit K");
  });

  it("never shows a disagreement about another person's identifier, even in a view that skipped read time", async () => {
    // Build and read time both drop these; this view stands in for one that did not.
    const side = (copy: number, value: string): LiveMirrorClaim => ({ source: "document_request_payment", origin: "record",
      label: `Document payment 1, copy ${copy}`, value, revision: 1, sourceUpdatedAt: T0, verifiedAt: T });
    mocks.peekLiveMirror.mockImplementation((uid: string) => ({ ...mirrorView(uid), conflicts: [
      { predicate: "document_request_payment.counterpartRef", label: "Person", claims: [side(1, "PERSON_REF_X"), side(2, "PERSON_REF_Y")] },
    ] }));
    render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    openProfileTab();
    await screen.findByTestId("live-mirror-status");
    expect(screen.queryByTestId("live-mirror-conflict")).toBeNull();
    expect(screen.queryByTestId("live-mirror-fix-at-source")).toBeNull();
    expect(document.body.textContent).not.toMatch(/PERSON_REF_[XY]/);
  });
  it("loads the shared To-do preview only when selected without a duplicate workspace link", async () => {
    const view = render(<OneAgentProfileSheet open={false} onOpenChange={mocks.close} />);
    expect(mocks.loadTasks).not.toHaveBeenCalled();
    view.rerender(<OneAgentProfileSheet open onOpenChange={mocks.close} />);
    expect(mocks.loadTasks).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab").map(tab => tab.textContent?.trim())).toEqual(["Feed", "To-do", "Profile"]);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "To-do" }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("Anytime task")).toBeInTheDocument();
    expect(screen.getByText("Tomorrow task")).toBeInTheDocument();
    expect(mocks.loadTasks).toHaveBeenCalledWith({ userId: "viewer", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token" });
    expect(screen.queryByRole("button", { name: /Open To-do List/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /Open To-do List/i })).toBeNull();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
