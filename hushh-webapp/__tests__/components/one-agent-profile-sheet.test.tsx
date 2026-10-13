import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneAgentProfileSheet } from "@/components/agent/one-agent-profile-sheet";
import { CacheService } from "@/lib/services/cache-service";

const mocks = vi.hoisted(() => ({
  unlocked: true,
  identityOwner: "viewer",
  preferredName: "Love",
  list: vi.fn(),
  markRead: vi.fn(),
  dismiss: vi.fn(),
  restore: vi.fn(),
  push: vi.fn(),
  close: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("viewer-token"),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "viewer", getIdToken: mocks.getIdToken } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: mocks.unlocked, vaultKey: mocks.unlocked ? "fixture-key" : null, vaultOwnerToken: mocks.unlocked ? "fixture-token" : null }),
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  usePkmDomainResource: () => ({ data: { key: { userId: mocks.identityOwner }, data: { communication_preferences: { preferred_name: mocks.preferredName } } } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/services/feed-service", () => ({
  FeedService: { list: mocks.list, markRead: mocks.markRead, dismiss: mocks.dismiss, restore: mocks.restore },
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
    const preview = screen.getAllByTestId("one-feed-preview-row");
    expect(preview).toHaveLength(1);
    fireEvent.click(preview[0].querySelector("button")!);
    expect(mocks.push).toHaveBeenCalledWith("/one/feed");
    expect(mocks.close).toHaveBeenCalledWith(false);
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Profile" }), {
      button: 0,
      ctrlKey: false,
    });
    const memory = await screen.findByRole("link", {
      name: "Open memory.md in Memory",
    });
    expect(memory).toHaveAttribute("href", "/one/pkm");
    expect(screen.getByText("Soul preview")).toBeInTheDocument();
    expect(screen.getByText("soul.md")).toBeInTheDocument();
    expect(screen.queryByText("Identity preview")).not.toBeInTheDocument();
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
});
