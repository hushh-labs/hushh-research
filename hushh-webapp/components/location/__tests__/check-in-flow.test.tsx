// @vitest-environment jsdom
/**
 * Check-In: the voice path stays pending from `check_in_created` through the
 * bridge's publish step, and reads "Sent" only once the server's persisted
 * grant carries an envelope. The tap path goes through `runCheckIn` and the
 * canonical publisher, coarsened to the account precision.
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
  useSearchParams: () => new URLSearchParams("action=check-in"),
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

import { CheckInFlow } from "@/components/location/check-in/check-in-flow";
import {
  dispatchServerFrame,
  useVoiceSessionStore,
} from "@/lib/one-voice/session-store";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../check-in/check-in-flow.tsx"),
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
    recipients: [PRIYA, SAM],
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

function armCheckIn() {
  useVoiceSessionStore.getState().emitToolResult("create_check_in", {
    status: "check_in_created",
    grant_id: "grant-9",
    person_user_id: "user-2",
    display_name: "Priya Nair",
    note: "Home safe",
    client_step: {
      kind: "publish_location_envelopes",
      grant_ids: ["grant-9"],
      purpose: "check_in",
    },
  });
}

function requestPublishStep() {
  dispatchServerFrame({
    type: "client_step.request",
    step_id: "step-1",
    kind: "publish_location_envelopes",
    payload: { grant_ids: ["grant-9"], purpose: "check_in" },
    timeout_s: 30,
  });
}

describe("CheckInFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceSessionStore.getState().reset();
    service.getState.mockResolvedValue(stateWith());
    service.captureCurrentPosition.mockResolvedValue({
      latitude: 12.97194,
      longitude: 77.59456,
      accuracyM: 8,
      capturedAt: new Date().toISOString(),
      sourcePlatform: "web",
    });
    service.createGrant.mockResolvedValue({
      id: "grant-1",
      ownerUserId: "user-1",
      recipientUserId: "user-2",
      recipientKeyId: "key-2",
      status: "active",
      consentScope: "location",
      capabilityScopes: [],
      durationHours: 1,
    });
    publisher.publishPointToGrants.mockResolvedValue({
      published: [
        {
          grantId: "grant-1",
          recipientUserId: "user-2",
          precision: "approximate",
          capturedAt: "",
          recipientAlerted: null,
        },
      ],
      failures: [],
      precision: "approximate",
      capturedAt: "",
    });
  });

  it("lists ready people first and preselects the person from the URL", async () => {
    render(<CheckInFlow personId="user-2" />);
    const priya = await screen.findByRole("radio", { name: /Priya Nair/ });
    expect(priya).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Sam Lee/ })).toBeDisabled();
    expect(screen.getByText("Needs a verified phone")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("user-2");
  });

  it("shows the card note while create_check_in waits for confirmation", async () => {
    render(<CheckInFlow personId="user-2" />);
    await screen.findByRole("radio", { name: /Priya Nair/ });
    act(() => {
      dispatchServerFrame({
        type: "pending_action",
        pending_action_id: "pa-1",
        tool: "create_check_in",
        gateway_action_id: "location.send_check_in",
        tier: "voice",
        summary: "Send Priya Nair a check-in",
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
    expect(screen.getByTestId("check-in-voice-pending")).toHaveTextContent(
      "Confirm on the card to send",
    );
    expect(screen.getByTestId("check-in-voice-pending")).toHaveTextContent(
      "Priya Nair",
    );
    expect(screen.queryByTestId("check-in-voice-state")).toBeNull();
  });

  it("stays pending from check_in_created through the publish step and says Sent only from the server's envelope", async () => {
    render(<CheckInFlow personId="user-2" />);
    await screen.findByRole("radio", { name: /Priya Nair/ });
    expect(service.getState).toHaveBeenCalledTimes(1);

    act(() => armCheckIn());
    const stateCard = screen.getByTestId("check-in-voice-state");
    expect(stateCard).toHaveAttribute("data-phase", "armed");
    expect(stateCard).toHaveTextContent("Sending your position to Priya Nair");
    expect(stateCard).not.toHaveTextContent("Sent to");

    act(() => requestPublishStep());
    expect(screen.getByTestId("check-in-voice-state")).toHaveAttribute(
      "data-phase",
      "publishing",
    );
    expect(screen.getByTestId("check-in-voice-state")).not.toHaveTextContent(
      "Sent to",
    );

    // The bridge reports; the server now holds an envelope on the grant.
    service.getState.mockResolvedValue(
      stateWith({
        ownerGrants: [
          {
            id: "grant-9",
            ownerUserId: "user-1",
            recipientUserId: "user-2",
            recipientKeyId: "key-2",
            status: "active",
            consentScope: "location",
            capabilityScopes: [],
            durationHours: 1,
            latestEnvelopeId: "env-1",
          },
        ],
      }),
    );
    act(() => {
      useVoiceSessionStore
        .getState()
        .dispatch({ type: "client_step_done", stepId: "step-1" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("check-in-voice-state")).toHaveAttribute(
        "data-phase",
        "sent",
      ),
    );
    expect(screen.getByTestId("check-in-voice-state")).toHaveTextContent(
      "Sent to Priya Nair",
    );
    expect(resource.invalidate).toHaveBeenCalledWith("user-1");
  });

  it("does not rewind a check-in past armed when the relay mirrors the same result twice", async () => {
    render(<CheckInFlow personId="user-2" />);
    await screen.findByRole("radio", { name: /Priya Nair/ });
    act(() => {
      useVoiceSessionStore.getState().emitPendingResolved("pa-1", "executed", {
        status: "check_in_created",
        grant_id: "grant-9",
        display_name: "Priya Nair",
      });
    });
    act(() => requestPublishStep());
    expect(screen.getByTestId("check-in-voice-state")).toHaveAttribute(
      "data-phase",
      "publishing",
    );
    act(() => armCheckIn());
    expect(screen.getByTestId("check-in-voice-state")).toHaveAttribute(
      "data-phase",
      "publishing",
    );
  });

  it("reports not sent when the step ends without an envelope on the server", async () => {
    render(<CheckInFlow personId="user-2" />);
    await screen.findByRole("radio", { name: /Priya Nair/ });
    act(() => armCheckIn());
    act(() => requestPublishStep());
    service.getState.mockResolvedValue(
      stateWith({
        ownerGrants: [
          {
            id: "grant-9",
            ownerUserId: "user-1",
            recipientUserId: "user-2",
            recipientKeyId: "key-2",
            status: "active",
            consentScope: "location",
            capabilityScopes: [],
            durationHours: 1,
            latestEnvelopeId: null,
          },
        ],
      }),
    );
    act(() => {
      useVoiceSessionStore
        .getState()
        .dispatch({ type: "client_step_done", stepId: "step-1" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("check-in-voice-state")).toHaveAttribute(
        "data-phase",
        "not_sent",
      ),
    );
    expect(screen.getByTestId("check-in-voice-state")).toHaveTextContent(
      "Not sent yet to Priya Nair",
    );
  });

  it("sends a tap check-in through runCheckIn and the canonical publisher at the account precision", async () => {
    render(<CheckInFlow personId="user-2" />);
    await screen.findByRole("radio", { name: /Priya Nair/ });
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: "Home safe" },
    });
    fireEvent.click(screen.getByTestId("check-in-send"));
    await waitFor(() => expect(service.createGrant).toHaveBeenCalledTimes(1));
    expect(service.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken: "owner-token",
        recipientUserId: "user-2",
        recipientKeyId: "key-2",
        durationHours: 1,
        reason: "Home safe",
      }),
    );
    await waitFor(() =>
      expect(publisher.publishPointToGrants).toHaveBeenCalledTimes(1),
    );
    const call = publisher.publishPointToGrants.mock.calls[0]?.[0] as {
      precision: string;
      sos?: boolean;
      point: {
        precision?: string;
        checkIn?: { message: string } | null;
        latitude: number;
      };
    };
    expect(call.precision).toBe("approximate");
    expect(call.sos).toBeUndefined();
    expect(call.point.precision).toBe("approximate");
    expect(call.point.latitude).toBe(12.97);
    expect(call.point.checkIn).toEqual({ message: "Home safe" });
    expect(await screen.findByTestId("check-in-outcome")).toHaveAttribute(
      "data-published",
      "true",
    );
    expect(screen.getByTestId("check-in-outcome")).toHaveTextContent(
      "Sent to Priya Nair",
    );
  });

  it("keeps the Location header contract", () => {
    expect(SOURCE).toContain('eyebrow="Location"');
    expect(SOURCE).toContain('title="Check-In"');
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("ChevronLeft");
    expect(SOURCE).not.toContain("onBack=");
  });
});
