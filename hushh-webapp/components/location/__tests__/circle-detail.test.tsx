// @vitest-environment jsdom
/**
 * Circle detail: the server's names only (never ids in text), owner tools
 * gated by the server's viewer capabilities, and voice reflecting only typed
 * outcomes -- a resolved `delete_circle` leaves the screen, a `link_ready`
 * result shows the URL the server returned.
 */

import fs from "node:fs";
import path from "node:path";

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  getCircleOverview: vi.fn(),
  listCircleMembersPage: vi.fn(),
  updateNamedCircle: vi.fn(),
  createNamedCircleInviteCode: vi.fn(),
  removeNamedCircleMember: vi.fn(),
  leaveNamedCircle: vi.fn(),
  deleteNamedCircle: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/one/location",
  useSearchParams: () => new URLSearchParams("action=circle-detail"),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "user-1",
    user: { uid: "user-1" },
    isAuthenticated: true,
    loading: false,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "owner-token", vaultKey: "vault-key" }),
}));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: service }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: toast }));
const publishSurface = vi.hoisted(() => vi.fn());
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: publishSurface,
}));
vi.mock("@/lib/voice/location-voice-actions", () => ({
  deriveLocationVoiceActions: () => [],
}));
vi.mock("@/lib/one-location/share-circle-code", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/one-location/share-circle-code")
    >();
  return {
    ...actual,
    shareNamedCircleCode: vi.fn().mockResolvedValue("copied"),
  };
});

import { CircleDetail } from "@/components/location/circles/circle-detail";
import {
  dispatchServerFrame,
  useVoiceSessionStore,
} from "@/lib/one-voice/session-store";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../circles/circle-detail.tsx"),
  "utf8",
);
const CIRCLE_ID = "6f1c1c1c-aaaa-4bbb-8ccc-1234567890ab";

function overview(overrides: Record<string, unknown> = {}) {
  return {
    id: CIRCLE_ID,
    name: "Weekend Hikers",
    kind: "friends",
    role: "owner",
    memberCount: 2,
    memberLimit: 25,
    viewerCapabilities: {
      canInviteMembers: true,
      canViewInviteCode: true,
      canRotateInviteCode: true,
      canManageCircle: true,
      canDeleteCircle: true,
      canLeaveCircle: false,
      canModerateInvites: true,
    },
    ...overrides,
  };
}

function membersPage() {
  return {
    items: [
      {
        userId: "user-1",
        displayName: "Ankit Singh",
        role: "owner",
        phoneVerified: true,
        secureLocationReady: true,
      },
      {
        userId: "user-2-abcdef",
        displayName: "Priya Nair",
        role: "member",
        phoneVerified: true,
        secureLocationReady: false,
        canReceiveLocation: false,
      },
    ],
    page: 1,
    hasMore: false,
    totalCount: 2,
  };
}

describe("CircleDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceSessionStore.getState().reset();
    service.getCircleOverview.mockResolvedValue(overview());
    service.listCircleMembersPage.mockResolvedValue(membersPage());
    service.deleteNamedCircle.mockResolvedValue(undefined);
  });

  it("renders the circle and its people by the names the server sent", async () => {
    render(<CircleDetail circleId={CIRCLE_ID} />);
    expect(await screen.findByTestId("circle-name")).toHaveTextContent(
      "Weekend Hikers",
    );
    expect(screen.getByText("Ankit Singh (you)")).toBeInTheDocument();
    expect(screen.getByText("Priya Nair")).toBeInTheDocument();
    expect(screen.getByText(/Location setup needed/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(CIRCLE_ID);
    expect(document.body.textContent).not.toContain("user-2-abcdef");
    expect(
      screen.getByRole("link", { name: /Invite people/ }).getAttribute("href"),
    ).toBe(`/one/location?action=invite-circle&circle=${CIRCLE_ID}`);
  });

  it("publishes this circle's id to voice as a typed field, never as screen state", async () => {
    render(<CircleDetail circleId={CIRCLE_ID} />);
    await screen.findByTestId("circle-name");
    const published = publishSurface.mock.calls
      .map((call) => call[0])
      .filter((meta): meta is Record<string, unknown> => Boolean(meta));
    expect(published.length).toBeGreaterThan(0);
    for (const meta of published) {
      expect(meta.screenId).toBe("one_location_circle");
      expect(meta.activeCircleId).toBe(CIRCLE_ID);
      // The id rides its own field; screenState is prompt text and carries none.
      expect(JSON.stringify(meta.screenState ?? {})).not.toContain(CIRCLE_ID);
    }
  });

  it("hides owner tools when the server's capabilities say so", async () => {
    service.getCircleOverview.mockResolvedValue(
      overview({
        role: "member",
        viewerCapabilities: {
          canInviteMembers: false,
          canViewInviteCode: false,
          canRotateInviteCode: false,
          canManageCircle: false,
          canDeleteCircle: false,
          canLeaveCircle: true,
          canModerateInvites: false,
        },
      }),
    );
    render(<CircleDetail circleId={CIRCLE_ID} />);
    await screen.findByTestId("circle-name");
    expect(screen.queryByRole("link", { name: /Invite people/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete circle/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rename circle/ })).toBeNull();
    const leaveCircle = screen.getByRole("button", { name: /Leave circle/ });
    expect(leaveCircle).toHaveClass("w-full", "max-w-[320px]");
    expect(leaveCircle.parentElement).toHaveClass("justify-end");
    expect(
      screen.getByTestId("circle-leave-icon").querySelector('[opacity="0.2"]'),
    ).toBeNull();
  });

  it("leaves the screen only when the server resolves delete_circle as executed", async () => {
    render(<CircleDetail circleId={CIRCLE_ID} />);
    await screen.findByTestId("circle-name");

    act(() => {
      dispatchServerFrame({
        type: "pending_action",
        pending_action_id: "pa-1",
        tool: "delete_circle",
        gateway_action_id: "location.delete_circle",
        tier: "tap",
        summary: "Delete Weekend Hikers",
        args: { circle: { circle_id: CIRCLE_ID } },
        status: "pending",
        shown_at: null,
        expires_at: null,
        result: null,
        risk_level: "high",
        requires_tap: true,
        entities: [],
      });
    });
    expect(screen.getByTestId("circle-voice-pending")).toHaveTextContent(
      "Confirm on the card to continue",
    );
    expect(router.replace).not.toHaveBeenCalled();

    act(() => {
      dispatchServerFrame({
        type: "pending_action.resolved",
        pending_action_id: "pa-1",
        status: "cancelled",
        result_public: null,
      });
      useVoiceSessionStore
        .getState()
        .emitPendingResolved("pa-1", "cancelled", null);
    });
    expect(router.replace).not.toHaveBeenCalled();

    act(() => {
      useVoiceSessionStore.getState().emitPendingResolved("pa-1", "executed", {
        status: "deleted",
        circle_id: CIRCLE_ID,
        name: "Weekend Hikers",
        ui_refresh: ["location_circles"],
      });
    });
    expect(router.replace).toHaveBeenCalledWith("/one/location?view=circles");
  });

  it("shows the join link the server returned from create_circle_invite_link", async () => {
    render(<CircleDetail circleId={CIRCLE_ID} />);
    await screen.findByTestId("circle-name");
    act(() => {
      useVoiceSessionStore
        .getState()
        .emitToolResult("create_circle_invite_link", {
          status: "link_ready",
          circle_id: CIRCLE_ID,
          code: "ABCD-EFGH-IJKL",
          url: "https://one.example/circle/join?code=ABCD-EFGH-IJKL",
          expires_at: null,
        });
    });
    expect(screen.getByTestId("circle-join-link")).toHaveTextContent(
      "https://one.example/circle/join?code=ABCD-EFGH-IJKL",
    );
  });

  it("deletes through the service after the dialog confirms", async () => {
    render(<CircleDetail circleId={CIRCLE_ID} />);
    await screen.findByTestId("circle-name");
    fireEvent.click(screen.getByRole("button", { name: /Delete circle/ }));
    const confirm = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(service.deleteNamedCircle).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        circleId: CIRCLE_ID,
      }),
    );
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/one/location?view=circles"),
    );
  });

  it("keeps the Location header contract", () => {
    expect(SOURCE).toContain('eyebrow="Location"');
    expect(SOURCE).toContain('title="Circle"');
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("ChevronLeft");
    expect(SOURCE).not.toContain("onBack=");
  });
});
