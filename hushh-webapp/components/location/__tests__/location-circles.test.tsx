// @vitest-environment jsdom
/**
 * Circles list: names only, never ids in text; a `create_circle` result with
 * status `created` navigates to the new circle; a spoken name never becomes
 * an id (the id comes from the server's `circle.circle_id`).
 */

import fs from "node:fs";
import path from "node:path";

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  listCircles: vi.fn(),
  listNamedCircleMemberInvites: vi.fn(),
  acceptNamedCircleMemberInvite: vi.fn(),
  declineNamedCircleMemberInvite: vi.fn(),
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
  useSearchParams: () => new URLSearchParams("view=circles"),
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

import { LocationCircles } from "@/components/location/circles/location-circles";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../circles/location-circles.tsx"),
  "utf8",
);

const CIRCLE_ID = "6f1c1c1c-aaaa-4bbb-8ccc-1234567890ab";

function circle(overrides: Record<string, unknown> = {}) {
  return {
    id: CIRCLE_ID,
    name: "Weekend Hikers",
    kind: "friends",
    role: "owner",
    memberCount: 3,
    memberLimit: 25,
    ...overrides,
  };
}

describe("LocationCircles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceSessionStore.getState().reset();
    service.listCircles.mockResolvedValue([circle()]);
    service.listNamedCircleMemberInvites.mockResolvedValue([]);
  });

  it("renders circle names the server sent and never an id in text", async () => {
    render(<LocationCircles />);
    expect(await screen.findByText("Weekend Hikers")).toBeInTheDocument();
    expect(screen.getByText(/Friends · 3 members/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(CIRCLE_ID);
    // The id is allowed only inside the href.
    const row = screen.getByTestId("circle-row");
    expect(row.getAttribute("href")).toContain(`circle=${CIRCLE_ID}`);
    expect(row.getAttribute("href")).toContain("action=circle-detail");
  });

  it("shows an honest empty state when there are no circles", async () => {
    service.listCircles.mockResolvedValue([]);
    render(<LocationCircles />);
    expect(await screen.findByText("No circles yet")).toBeInTheDocument();
  });

  it("navigates to the new circle only from a create_circle result with status created", async () => {
    render(<LocationCircles />);
    await screen.findByText("Weekend Hikers");

    // A neutral status navigates nowhere.
    act(() => {
      useVoiceSessionStore.getState().emitToolResult("create_circle", {
        status: "already_exists",
        circle: { circle_id: "existing-id", name: "Weekend Hikers" },
      });
    });
    expect(router.push).not.toHaveBeenCalled();

    act(() => {
      useVoiceSessionStore.getState().emitToolResult("create_circle", {
        status: "created",
        circle: { circle_id: "new-circle-id", name: "Book Club" },
        ui_refresh: ["location_circles"],
      });
    });
    expect(router.push).toHaveBeenCalledWith(
      "/one/location?action=circle-detail&circle=new-circle-id",
    );
  });

  it("refetches the list when a circle mutation succeeds, not when it is rejected", async () => {
    render(<LocationCircles />);
    await screen.findByText("Weekend Hikers");
    expect(service.listCircles).toHaveBeenCalledTimes(1);

    act(() => {
      useVoiceSessionStore.getState().emitToolResult("rename_circle", {
        status: "rejected",
        ui_refresh: ["location_circles"],
      });
    });
    expect(service.listCircles).toHaveBeenCalledTimes(1);

    act(() => {
      useVoiceSessionStore.getState().emitToolResult("rename_circle", {
        status: "renamed",
        circle: { circle_id: CIRCLE_ID, name: "Trail Crew" },
        ui_refresh: ["location_circles"],
      });
    });
    await waitFor(() => expect(service.listCircles).toHaveBeenCalledTimes(2));
  });

  it("renders incoming invites with the inviter's name and responds through the service", async () => {
    service.listNamedCircleMemberInvites.mockResolvedValue([
      {
        id: "invite-1",
        circleId: "circle-2",
        circleName: "Chess Club",
        circleKind: "other",
        inviterUserId: "user-9",
        inviterDisplayName: "Priya Nair",
        inviteeUserId: "user-1",
        status: "pending",
      },
    ]);
    service.acceptNamedCircleMemberInvite.mockResolvedValue({
      id: "circle-2",
      name: "Chess Club",
    });
    render(<LocationCircles />);
    expect(await screen.findByText("Chess Club")).toBeInTheDocument();
    expect(screen.getByText("Priya Nair invited you")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("user-9");
    act(() => {
      screen.getByRole("button", { name: "Accept" }).click();
    });
    await waitFor(() =>
      expect(service.acceptNamedCircleMemberInvite).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        inviteId: "invite-1",
      }),
    );
  });

  it("keeps the Location header contract", () => {
    expect(SOURCE).toContain('eyebrow="Location"');
    expect(SOURCE).toContain('title="Circles"');
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("ChevronLeft");
    expect(SOURCE).not.toContain("onBack=");
  });
});
