import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneAgentProfileSheet } from "@/components/agent/one-agent-profile-sheet";
import { CacheService } from "@/lib/services/cache-service";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  markRead: vi.fn(),
  push: vi.fn(),
  close: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("viewer-token"),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "viewer", getIdToken: mocks.getIdToken } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: {} as CryptoKey,
    vaultOwnerToken: "vault-token",
    isVaultUnlocked: true,
  }),
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  usePkmDomainResource: () => ({ data: null }),
}));
vi.mock("@/lib/services/todo-list-pkm-service", () => ({
  TodoListPkmService: {
    load: vi.fn().mockResolvedValue({
      tasks: [
        { id: "task-anytime", title: "Anytime task", date: null, status: "pending", type: "manual" },
        { id: "task-dated", title: "Tomorrow task", date: "2099-01-01", status: "pending", type: "manual" },
      ],
    }),
    toggle: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
  },
  openTodoItems: (tasks: any[]) => tasks.filter((t: any) => t.status !== "done"),
  completedTodoItems: (tasks: any[]) => tasks.filter((t: any) => t.status === "done"),
  TODO_SOURCE_LABELS: { calendar: "Calendar", gmail: "Mail", manual: "Personal" },
}));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    status: { connected: true, google_email: "test@example.com" },
  }),
}));
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

describe("One agent profile feed preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Profile" }), {
      button: 0,
      ctrlKey: false,
    });
    const memory = await screen.findByRole("link", {
      name: "Open memory.md in Memory",
    });
    expect(memory).toHaveAttribute("href", "/one/pkm");
    expect(screen.getByText("Soul preview")).toBeInTheDocument();
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

  it("renders the To-do tab between Feed and Profile and shows tasks preview", async () => {
    render(<OneAgentProfileSheet open onOpenChange={mocks.close} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.trim())).toEqual([
      "Feed",
      "To-do",
      "Profile",
    ]);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "To-do" }), {
      button: 0,
      ctrlKey: false,
    });

    await screen.findByText("To-do list");
    expect(screen.getByText("Anytime task")).toBeInTheDocument();
    expect(screen.getByText("Tomorrow task")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /Open To-do List/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open To-do List/i })).not.toBeInTheDocument();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
