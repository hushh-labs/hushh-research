// @vitest-environment jsdom
/**
 * New circle: the tap path creates through the service and opens the detail;
 * the voice path opens the detail only from a `create_circle` result whose
 * status is `created` (and whose id the SERVER supplied) -- never from the
 * confirmation card, never from a spoken name.
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

const service = vi.hoisted(() => ({ createNamedCircle: vi.fn() }));
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
  useSearchParams: () => new URLSearchParams("action=create-circle"),
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

import { CreateCircleFlow } from "@/components/location/circles/create-circle-flow";
import {
  dispatchServerFrame,
  useVoiceSessionStore,
} from "@/lib/one-voice/session-store";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../circles/create-circle-flow.tsx"),
  "utf8",
);

describe("CreateCircleFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceSessionStore.getState().reset();
  });

  it("creates through the service and opens the new circle", async () => {
    service.createNamedCircle.mockResolvedValue({
      id: "circle-new",
      name: "Book Club",
      kind: "friends",
    });
    render(<CreateCircleFlow />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Book Club " },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Friends/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create circle/ }));
    await waitFor(() =>
      expect(service.createNamedCircle).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        name: "Book Club",
        kind: "friends",
      }),
    );
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        "/one/location?action=circle-detail&circle=circle-new",
      ),
    );
  });

  it("refuses an empty name without calling the service", () => {
    render(<CreateCircleFlow />);
    const button = screen.getByRole("button", { name: /Create circle/ });
    expect(button).toBeDisabled();
    expect(service.createNamedCircle).not.toHaveBeenCalled();
  });

  it("shows the card note while create_circle waits for confirmation, then opens on created", () => {
    render(<CreateCircleFlow />);
    act(() => {
      dispatchServerFrame({
        type: "pending_action",
        pending_action_id: "pa-7",
        tool: "create_circle",
        gateway_action_id: "location.create_circle",
        tier: "voice",
        summary: "Create a circle called Book Club",
        args: { name: "Book Club" },
        status: "pending",
        shown_at: null,
        expires_at: null,
        result: null,
        risk_level: "medium",
        requires_tap: false,
        entities: [],
      });
    });
    expect(screen.getByTestId("create-circle-voice-pending")).toHaveTextContent(
      "Confirm on the card to create it",
    );
    expect(router.replace).not.toHaveBeenCalled();

    act(() => {
      useVoiceSessionStore.getState().emitPendingResolved("pa-7", "executed", {
        status: "created",
        circle: { circle_id: "circle-77", name: "Book Club" },
        ui_refresh: ["location_circles"],
      });
    });
    expect(router.replace).toHaveBeenCalledWith(
      "/one/location?action=circle-detail&circle=circle-77",
    );
  });

  it("never navigates from a result without a server-supplied id", () => {
    render(<CreateCircleFlow />);
    act(() => {
      useVoiceSessionStore.getState().emitToolResult("create_circle", {
        status: "created",
        spoken_facts: ["Created Book Club."],
      });
    });
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps the Location header contract", () => {
    expect(SOURCE).toContain('eyebrow="Location"');
    expect(SOURCE).toContain('title="New circle"');
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("ChevronLeft");
    expect(SOURCE).not.toContain("onBack=");
  });
});
