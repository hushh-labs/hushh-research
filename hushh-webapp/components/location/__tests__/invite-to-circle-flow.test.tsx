// @vitest-environment jsdom
/**
 * Invite to circle: before Send the screen names exactly who will receive the
 * invite and which circle; afterwards each row shows the state the service
 * reports (pending / accepted / declined / cancelled / expired), never one
 * inferred from speech.
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
  listNamedCircleEligibleConnectionsPage: vi.fn(),
  listNamedCircleMemberInvites: vi.fn(),
  addNamedCircleMembers: vi.fn(),
  cancelNamedCircleMemberInvite: vi.fn(),
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/one/location",
  useSearchParams: () => new URLSearchParams("action=invite-circle"),
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
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/voice/location-voice-actions", () => ({
  deriveLocationVoiceActions: () => [],
}));

import { InviteToCircleFlow } from "@/components/location/circles/invite-to-circle-flow";
import {
  dispatchServerFrame,
  useVoiceSessionStore,
} from "@/lib/one-voice/session-store";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../circles/invite-to-circle-flow.tsx"),
  "utf8",
);
const CIRCLE_ID = "6f1c1c1c-aaaa-4bbb-8ccc-1234567890ab";

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-1",
    circleId: CIRCLE_ID,
    circleName: "Weekend Hikers",
    circleKind: "friends",
    inviterUserId: "user-1",
    inviterDisplayName: "Ankit Singh",
    inviteeUserId: "user-3",
    inviteeDisplayName: "Rahul Mehta",
    status: "pending",
    ...overrides,
  };
}

describe("InviteToCircleFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceSessionStore.getState().reset();
    service.getCircleOverview.mockResolvedValue({
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
        canModerateInvites: true,
      },
    });
    service.listNamedCircleEligibleConnectionsPage.mockResolvedValue({
      eligibleConnections: [
        {
          connectionId: "conn-1",
          userId: "user-2",
          displayName: "Priya Nair",
          isRia: false,
        },
        {
          connectionId: "conn-2",
          userId: "user-4",
          displayName: "Sam Lee",
          isRia: false,
        },
      ],
      pendingInvites: [invite()],
      remainingCapacity: 10,
      page: 1,
      hasMore: false,
      totalCount: 2,
    });
    service.listNamedCircleMemberInvites.mockImplementation(
      async ({ status }: { status: string }) =>
        status === "declined"
          ? [
              invite({
                id: "invite-2",
                inviteeUserId: "user-5",
                inviteeDisplayName: "Maya Roy",
                status: "declined",
              }),
            ]
          : [],
    );
    service.addNamedCircleMembers.mockResolvedValue({
      added: ["user-2"],
      skipped: [],
      skippedReasons: {},
      invited: [],
    });
  });

  it("states exactly who will receive the invite and which circle before sending", async () => {
    render(<InviteToCircleFlow circleId={CIRCLE_ID} />);
    expect(await screen.findByTestId("invite-review-circle")).toHaveTextContent(
      "Weekend Hikers",
    );
    expect(screen.getByTestId("invite-review-recipients")).toHaveTextContent(
      "Nobody yet",
    );
    expect(screen.getByTestId("invite-send")).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Add Priya Nair"));
    expect(screen.getByTestId("invite-review-recipients")).toHaveTextContent(
      "Priya Nair",
    );
    fireEvent.click(screen.getByLabelText("Add Sam Lee"));
    expect(screen.getByTestId("invite-review-recipients")).toHaveTextContent(
      "Priya Nair and Sam Lee",
    );
    expect(document.body.textContent).not.toContain("user-2");
    expect(document.body.textContent).not.toContain(CIRCLE_ID);
  });

  it("shows real invite states from the service", async () => {
    render(<InviteToCircleFlow circleId={CIRCLE_ID} />);
    const list = await screen.findByTestId("invite-list");
    expect(list).toHaveTextContent("Rahul Mehta");
    expect(list).toHaveTextContent("Pending");
    expect(list).toHaveTextContent("Maya Roy");
    expect(list).toHaveTextContent("Declined");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("sends only the selected people through the service and reports the real outcome", async () => {
    render(<InviteToCircleFlow circleId={CIRCLE_ID} />);
    await screen.findByTestId("invite-review-circle");
    fireEvent.click(screen.getByLabelText("Add Priya Nair"));
    fireEvent.click(screen.getByTestId("invite-send"));
    await waitFor(() =>
      expect(service.addNamedCircleMembers).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        circleId: CIRCLE_ID,
        inviteeUserIds: ["user-2"],
      }),
    );
    expect(await screen.findByTestId("invite-outcome")).toHaveTextContent(
      "Priya Nair is in Weekend Hikers.",
    );
  });

  it("preselects the person named in the URL when they are eligible", async () => {
    render(<InviteToCircleFlow circleId={CIRCLE_ID} userId="user-4" />);
    await screen.findByTestId("invite-review-circle");
    await waitFor(() =>
      expect(screen.getByTestId("invite-review-recipients")).toHaveTextContent(
        "Sam Lee",
      ),
    );
  });

  it("shows the card note while add_circle_member waits, and refetches once it resolves", async () => {
    render(<InviteToCircleFlow circleId={CIRCLE_ID} />);
    await screen.findByTestId("invite-review-circle");
    expect(
      service.listNamedCircleEligibleConnectionsPage,
    ).toHaveBeenCalledTimes(1);
    act(() => {
      dispatchServerFrame({
        type: "pending_action",
        pending_action_id: "pa-3",
        tool: "add_circle_member",
        gateway_action_id: "location.add_to_circle",
        tier: "voice",
        summary: "Add Priya Nair to Weekend Hikers",
        args: {},
        status: "pending",
        shown_at: null,
        expires_at: null,
        result: null,
        risk_level: "medium",
        requires_tap: false,
        entities: [
          { kind: "person", user_id: "user-2", display_name: "Priya Nair" },
        ],
      });
    });
    expect(screen.getByTestId("invite-voice-pending")).toHaveTextContent(
      "Confirm on the card to send",
    );
    act(() => {
      useVoiceSessionStore.getState().emitPendingResolved("pa-3", "executed", {
        status: "invite_pending",
        circle_id: CIRCLE_ID,
        user_id: "user-2",
        ui_refresh: ["location_circles"],
      });
    });
    await waitFor(() =>
      expect(
        service.listNamedCircleEligibleConnectionsPage,
      ).toHaveBeenCalledTimes(2),
    );
  });

  it("keeps the Location header contract", () => {
    expect(SOURCE).toContain('eyebrow="Location"');
    expect(SOURCE).toContain('title="Invite to circle"');
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("ChevronLeft");
    expect(SOURCE).not.toContain("onBack=");
  });
});
