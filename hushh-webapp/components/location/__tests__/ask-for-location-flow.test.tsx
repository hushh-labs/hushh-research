import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ask for location: the person comes from server state (or Connect, with the
 * server's name); not connected means an Invite CTA and NEVER a request;
 * connected sends `requestAccess` and shows the request the server returned.
 */

const harness = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  getState: vi.fn(),
  listRecipientsPage: vi.fn(),
  requestAccess: vi.fn(),
  withdrawRequest: vi.fn(),
  getPersonContext: vi.fn(),
  getIdToken: vi.fn(async () => "firebase-id-token"),
  push: vi.fn(),
  replace: vi.fn(),
  publish: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "me",
    user: { getIdToken: harness.getIdToken },
    loading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vault-token", vaultKey: "key" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: harness.push, replace: harness.replace }),
  usePathname: () => "/one/location",
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: harness.getState,
    listRecipientsPage: harness.listRecipientsPage,
    requestAccess: harness.requestAccess,
    withdrawRequest: harness.withdrawRequest,
  },
}));
vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: { getPersonContext: harness.getPersonContext },
}));
vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: {
    readPresentation: () => harness.state,
    load: async (_userId: string, loader: () => Promise<unknown>) => {
      const next = await loader();
      harness.state = next as Record<string, unknown>;
      return next;
    },
    invalidate: vi.fn(),
    mergeOwnerGrant: vi.fn(),
    mergeRequestStatus: vi.fn(),
    write: vi.fn(),
  },
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: (metadata: unknown) =>
    harness.publish(metadata),
}));
vi.mock("@/lib/voice/location-voice-actions", () => ({
  deriveLocationVoiceActions: () => [],
}));
vi.mock("@/lib/one-voice/session-store", () => ({
  useVoiceToolEffects: () => undefined,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: harness.toast }));

import { AskForLocationFlow } from "@/components/location/ask/ask-for-location-flow";

const PRIYA = {
  userId: "u2",
  displayName: "Priya Sharma",
  photoUrl: null,
  phoneVerified: true,
  keyAlgorithm: "ECDH-P256",
  keyId: "k2",
  publicKeyJwk: { kty: "EC" },
  canReceiveLocation: true,
};

function stateWith(recipients: unknown[], requests: unknown[] = []) {
  return {
    recipients,
    ownerGrants: [],
    receivedGrants: [],
    requests,
    referrals: [],
    publicInvites: [],
    publicInviteSubmissions: [],
    capabilityScopes: [],
    viewerCapabilities: { canRequestLocation: true },
  };
}

describe("AskForLocationFlow", () => {
  beforeEach(() => {
    harness.state = null;
    harness.getState.mockReset();
    harness.listRecipientsPage.mockResolvedValue({
      items: [PRIYA],
      page: 1,
      hasMore: false,
      totalCount: 1,
    });
    harness.requestAccess.mockReset();
    harness.getPersonContext.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the breadcrumb title and publishes one_location_ask", async () => {
    harness.getState.mockResolvedValue(stateWith([PRIYA]));
    render(<AskForLocationFlow personId="u2" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Ask for location",
    );
    const metadata = harness.publish.mock.calls.at(-1)?.[0] as {
      screenId: string;
    };
    expect(metadata.screenId).toBe("one_location_ask");
    await screen.findByTestId("ask-connected");
  });

  it("renders the not-connected notice with an Invite CTA and never calls requestAccess", async () => {
    harness.getState.mockResolvedValue(stateWith([]));
    harness.getPersonContext.mockResolvedValue({
      person: {
        userId: "stranger-1",
        displayName: "Neha Kapoor",
        photoUrl: null,
        email: null,
        relationship: "none",
      },
      request: null,
    });
    render(<AskForLocationFlow personId="stranger-1" />);
    const notice = await screen.findByTestId("ask-not-connected");
    expect(notice).toHaveTextContent(
      "You are not connected with Neha Kapoor yet.",
    );
    expect(notice).not.toHaveTextContent("stranger-1");
    const cta = screen.getByTestId("ask-invite-cta");
    expect(cta).toHaveAttribute(
      "href",
      expect.stringContaining("/one/connect"),
    );
    expect(screen.queryByTestId("ask-send")).toBeNull();
    expect(harness.requestAccess).not.toHaveBeenCalled();
    expect(harness.getPersonContext).toHaveBeenCalledWith({
      idToken: "firebase-id-token",
      counterpartUserId: "stranger-1",
    });
  });

  it("sends a real request for a connected person and shows the server's status", async () => {
    harness.getState.mockResolvedValue(stateWith([PRIYA]));
    harness.requestAccess.mockResolvedValue({
      id: "req-1",
      ownerUserId: "u2",
      requesterUserId: "me",
      status: "pending",
      requestedDurationHours: 2,
    });
    render(<AskForLocationFlow personId="u2" />);
    await screen.findByTestId("ask-connected");
    expect(harness.getPersonContext).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "2 hours" }));
    fireEvent.click(screen.getByTestId("ask-send"));
    await waitFor(() =>
      expect(harness.requestAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          vaultOwnerToken: "vault-token",
          ownerUserId: "u2",
          requestedDurationHours: 2,
          requestedDurationMode: "timed",
        }),
      ),
    );
    expect(await screen.findByTestId("ask-pending")).toHaveTextContent(
      "You already asked Priya Sharma",
    );
    expect(screen.getByText("Waiting for their answer")).toBeInTheDocument();
  });

  it("shows an existing pending request instead of a second Ask button", async () => {
    harness.getState.mockResolvedValue(
      stateWith(
        [PRIYA],
        [
          {
            id: "req-0",
            ownerUserId: "u2",
            requesterUserId: "me",
            status: "pending",
            requestedDurationHours: 1,
          },
        ],
      ),
    );
    render(<AskForLocationFlow personId="u2" />);
    expect(await screen.findByTestId("ask-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("ask-send")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Withdraw request" }),
    ).toBeInTheDocument();
  });
});
