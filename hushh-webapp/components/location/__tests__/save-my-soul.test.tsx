// @vitest-environment jsdom
/**
 * Save My Soul: honest empty state with no contacts; per-contact badges from
 * the server's phone-verification and key facts; "sent"/"alerted" only after
 * real delivery results (tap) or the server's delivery verification (voice);
 * the confirmation card is never confirmed here; SOS is always precise.
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
  getState: vi.fn(),
  captureCurrentPosition: vi.fn(),
  createGrant: vi.fn(),
  storeEnvelope: vi.fn(),
  sendSosEmails: vi.fn(),
  revokeGrant: vi.fn(),
}));
const publisher = vi.hoisted(() => ({ publishPointToGrants: vi.fn() }));
const sharing = vi.hoisted(() => ({
  os: "granted",
  osPrecise: true,
  appSharing: true,
  sharingState: "on",
  precision: "approximate" as "precise" | "approximate",
  paused: false,
  effective: "sharing",
  activeShareCount: 0,
  resolving: false,
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const resource = vi.hoisted(() => ({
  readPresentation: vi.fn(() => null),
  invalidate: vi.fn(),
  load: vi.fn(async (_uid: string, loader: () => Promise<unknown>) => loader()),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/one/location",
  useSearchParams: () => new URLSearchParams("action=sos"),
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
vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: resource,
}));
vi.mock("@/lib/location/publisher", () => publisher);
vi.mock("@/lib/location/sharing-state", () => ({
  useLocationSharingState: () => sharing,
}));
vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: vi.fn(),
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: toast }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/voice/location-voice-actions", () => ({
  deriveLocationVoiceActions: () => [],
}));

import { SaveMySoul } from "@/components/location/sos/save-my-soul";
import { clearSosIncident } from "@/lib/one-location/sos-incident";
import {
  dispatchServerFrame,
  useVoiceSessionStore,
} from "@/lib/one-voice/session-store";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../sos/save-my-soul.tsx"),
  "utf8",
);

const PRIYA = {
  userId: "user-2",
  displayName: "Priya Nair",
  phoneVerified: true,
  keyId: "key-2",
  publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  keyAlgorithm: "ECDH-P256",
  canReceiveLocation: true,
};
const RAHUL = {
  userId: "user-3",
  displayName: "Rahul Mehta",
  phoneVerified: true,
  keyId: "key-3",
  publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  keyAlgorithm: "ECDH-P256",
  canReceiveLocation: true,
};
const SAM = {
  userId: "user-4",
  displayName: "Sam Lee",
  phoneVerified: false,
  keyId: null,
  publicKeyJwk: null,
  keyAlgorithm: "ECDH-P256",
  canReceiveLocation: false,
};

function stateWith(overrides: Record<string, unknown> = {}) {
  return {
    recipients: [PRIYA, RAHUL, SAM],
    smsContactUserIds: ["user-2", "user-3", "user-4"],
    ownerGrants: [],
    receivedGrants: [],
    requests: [],
    referrals: [],
    publicInvites: [],
    publicInviteSubmissions: [],
    capabilityScopes: [],
    ...overrides,
  };
}

describe("SaveMySoul", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSosIncident();
    useVoiceSessionStore.getState().reset();
    service.getState.mockResolvedValue(stateWith());
    service.captureCurrentPosition.mockResolvedValue({
      latitude: 12.97194,
      longitude: 77.59456,
      accuracyM: 8,
      capturedAt: new Date().toISOString(),
      sourcePlatform: "web",
    });
    let grantCount = 0;
    service.createGrant.mockImplementation(
      async ({ recipientUserId }: { recipientUserId: string }) => ({
        id: `grant-${++grantCount}`,
        ownerUserId: "user-1",
        recipientUserId,
        recipientKeyId: "key",
        status: "active",
        consentScope: "location",
        capabilityScopes: [],
        durationHours: 8,
        shareKind: "sos",
      }),
    );
    service.sendSosEmails.mockResolvedValue({
      emailed: 1,
      attempted: 2,
      configured: true,
      withoutEmail: ["Rahul Mehta"],
    });
    publisher.publishPointToGrants.mockImplementation(
      async ({
        grants,
      }: {
        grants: Array<{ id: string; recipientUserId: string }>;
      }) => ({
        published: grants.map((grant) => ({
          grantId: grant.id,
          recipientUserId: grant.recipientUserId,
          precision: "precise",
          capturedAt: "",
          recipientAlerted: grant.recipientUserId === "user-2",
        })),
        failures: [],
        precision: "precise",
        capturedAt: "",
      }),
    );
  });

  it("shows an honest empty state and no Send when there are no emergency contacts", async () => {
    service.getState.mockResolvedValue(stateWith({ smsContactUserIds: [] }));
    render(<SaveMySoul />);
    expect(
      await screen.findByText("No emergency contacts yet"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("sos-send")).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/\bSent to\b/);
    expect(document.body.textContent).not.toMatch(/: alerted/);
    expect(screen.queryByTestId("sos-delivery")).toBeNull();
  });

  it("renders the real contacts with separate phone and key badges, never ids", async () => {
    render(<SaveMySoul />);
    const rows = await screen.findAllByTestId("sos-contact");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Priya Nair");
    expect(rows[0]).toHaveTextContent("Phone verified");
    expect(rows[0]).toHaveTextContent("Has key");
    expect(rows[2]).toHaveTextContent("Sam Lee");
    expect(rows[2]).toHaveTextContent("Phone not verified");
    expect(rows[2]).toHaveTextContent("No key yet");
    expect(document.body.textContent).not.toContain("user-2");
    expect(
      screen.getByText(/always sends your precise position/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("sos-send")).toHaveTextContent(
      "Send alert to 2 contacts",
    );
  });

  it("sends through runSosPanic, forces precise, and reports delivery per contact from real results", async () => {
    render(<SaveMySoul />);
    await screen.findAllByTestId("sos-contact");
    expect(screen.queryByTestId("sos-delivery")).toBeNull();

    fireEvent.click(screen.getByTestId("sos-send"));
    await waitFor(() => expect(service.createGrant).toHaveBeenCalledTimes(2));
    expect(service.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: "user-2",
        shareKind: "sos",
        durationHours: 8,
      }),
    );
    expect(service.createGrant).not.toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: "user-4" }),
    );
    await waitFor(() =>
      expect(publisher.publishPointToGrants).toHaveBeenCalledTimes(2),
    );
    for (const call of publisher.publishPointToGrants.mock.calls) {
      const params = call[0] as { precision: string; sos?: boolean };
      expect(params.precision).toBe("precise");
      expect(params.sos).toBe(true);
    }

    const delivery = await screen.findByTestId("sos-delivery");
    expect(delivery).toHaveTextContent("Priya Nair: alerted");
    expect(delivery).toHaveTextContent(
      "Rahul Mehta: not alerted (notifications off)",
    );
    expect(delivery).toHaveTextContent("Emailed 1.");
    expect(delivery).toHaveTextContent("No email on file for Rahul Mehta.");
    expect(delivery).toHaveTextContent("Skipped Sam Lee — not ready.");
    expect(service.sendSosEmails).toHaveBeenCalledWith(
      expect.objectContaining({ grantIds: ["grant-1", "grant-2"] }),
    );
    expect(screen.getByTestId("sos-active")).toBeInTheDocument();
  });

  it("never sends when the device cannot produce a position", async () => {
    service.captureCurrentPosition.mockRejectedValue(new Error("no fix"));
    render(<SaveMySoul />);
    await screen.findAllByTestId("sos-contact");
    fireEvent.click(screen.getByTestId("sos-send"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't get your location — alert not sent. Check location permission.",
      ),
    );
    expect(service.createGrant).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sos-delivery")).toBeNull();
  });

  it("says Confirm on the card while the voice trigger waits, and disables its own Send", async () => {
    render(<SaveMySoul />);
    await screen.findAllByTestId("sos-contact");
    act(() => {
      dispatchServerFrame({
        type: "pending_action",
        pending_action_id: "pa-sos",
        tool: "trigger_save_my_soul",
        gateway_action_id: "location.trigger_sos",
        tier: "tap",
        summary: "Send a Save My Soul alert to Priya Nair and Rahul Mehta",
        args: {},
        status: "pending",
        shown_at: null,
        expires_at: null,
        result: null,
        risk_level: "high",
        requires_tap: true,
        entities: [],
      });
    });
    expect(screen.getByTestId("sos-voice-pending")).toHaveTextContent(
      "Confirm on the card to send",
    );
    expect(screen.getByTestId("sos-send")).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/\bSent to\b/);
  });

  it("treats sos_grants_created as armed, and reports sent only from the server's delivery verification", async () => {
    render(<SaveMySoul />);
    await screen.findAllByTestId("sos-contact");

    act(() => {
      useVoiceSessionStore
        .getState()
        .emitPendingResolved("pa-sos", "executed", {
          status: "sos_grants_created",
          grant_ids: ["grant-a", "grant-b"],
          armed: [
            {
              grant_id: "grant-a",
              user_id: "user-2",
              display_name: "Priya Nair",
            },
            {
              grant_id: "grant-b",
              user_id: "user-3",
              display_name: "Rahul Mehta",
            },
          ],
          client_step: {
            kind: "publish_location_envelopes",
            grant_ids: ["grant-a", "grant-b"],
            purpose: "sos",
          },
        });
    });
    const armed = screen.getByTestId("sos-voice-state");
    expect(armed).toHaveAttribute("data-phase", "armed");
    expect(armed).toHaveTextContent("Armed for Priya Nair and Rahul Mehta");
    expect(armed).toHaveTextContent("Not sent yet");
    expect(armed).not.toHaveTextContent("Sent to");

    act(() => {
      useVoiceSessionStore
        .getState()
        .emitToolResult("report_save_my_soul_delivery", {
          status: "sos_partial",
          delivered: ["Priya Nair"],
          not_alerted: ["Rahul Mehta"],
          delivered_grant_ids: ["grant-a"],
          not_alerted_grant_ids: ["grant-b"],
        });
    });
    const reported = screen.getByTestId("sos-voice-state");
    expect(reported).toHaveAttribute("data-phase", "reported");
    expect(reported).toHaveTextContent("Sent to Priya Nair");
    expect(reported).toHaveTextContent("Not alerted: Rahul Mehta.");
  });

  it("clears the active state when the server says sos_stopped", async () => {
    render(<SaveMySoul />);
    await screen.findAllByTestId("sos-contact");
    act(() => {
      useVoiceSessionStore
        .getState()
        .emitPendingResolved("pa-sos", "executed", {
          status: "sos_grants_created",
          grant_ids: ["grant-a"],
          armed: [
            {
              grant_id: "grant-a",
              user_id: "user-2",
              display_name: "Priya Nair",
            },
          ],
        });
    });
    expect(screen.getByTestId("sos-active")).toBeInTheDocument();
    act(() => {
      useVoiceSessionStore
        .getState()
        .emitPendingResolved("pa-stop", "executed", {
          status: "sos_stopped",
          stopped_count: 1,
          ui_refresh: ["location_sos", "location_home"],
        });
    });
    await waitFor(() => expect(screen.queryByTestId("sos-active")).toBeNull());
    expect(screen.queryByTestId("sos-voice-state")).toBeNull();
  });

  it("keeps the Location header contract", () => {
    expect(SOURCE).toContain('eyebrow="Location"');
    expect(SOURCE).toContain('title="Save My Soul"');
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("ChevronLeft");
    expect(SOURCE).not.toContain("onBack=");
    expect(SOURCE).not.toContain("text-white");
    expect(SOURCE).not.toContain("bg-black");
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
