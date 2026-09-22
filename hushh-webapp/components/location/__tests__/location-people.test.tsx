import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * People tab: connected people come from the server (names, photos), pending
 * requests come from the state, and zero connections is an honest empty
 * state that sends the person to Connect -- never a fabricated request.
 */

const harness = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  getState: vi.fn(),
  listRecipientsPage: vi.fn(),
  requestAccess: vi.fn(),
  approveRequest: vi.fn(),
  denyRequest: vi.fn(),
  withdrawRequest: vi.fn(),
  push: vi.fn(),
  publish: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "me",
    user: null,
    loading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vault-token", vaultKey: "key" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: harness.push, replace: vi.fn() }),
  usePathname: () => "/one/location",
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: harness.getState,
    listRecipientsPage: harness.listRecipientsPage,
    requestAccess: harness.requestAccess,
    approveRequest: harness.approveRequest,
    denyRequest: harness.denyRequest,
    withdrawRequest: harness.withdrawRequest,
  },
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

import { LocationPeople } from "@/components/location/people/location-people";

const EMPTY_STATE = {
  recipients: [],
  ownerGrants: [],
  receivedGrants: [],
  requests: [],
  referrals: [],
  publicInvites: [],
  publicInviteSubmissions: [],
  capabilityScopes: [],
};

const PRIYA = {
  userId: "u2",
  displayName: "Priya Sharma",
  photoUrl: null,
  phoneVerified: true,
  keyAlgorithm: "ECDH-P256",
  keyId: "k2",
  publicKeyJwk: { kty: "EC" },
  canReceiveLocation: true,
  relationshipType: "family",
};

describe("LocationPeople", () => {
  beforeEach(() => {
    harness.state = null;
    harness.getState.mockReset();
    harness.getState.mockResolvedValue(EMPTY_STATE);
    harness.listRecipientsPage.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows an honest empty state with an Invite link and sends no request", async () => {
    harness.listRecipientsPage.mockResolvedValue({
      items: [],
      page: 1,
      hasMore: false,
      totalCount: 0,
    });
    render(<LocationPeople />);
    expect(
      await screen.findByText("No one to share with yet"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("location-people-empty-invite")).toHaveAttribute(
      "href",
      "/one/connect",
    );
    expect(screen.queryByTestId("location-person-row")).toBeNull();
    expect(screen.queryByTestId("location-people-incoming-row")).toBeNull();
    expect(harness.requestAccess).not.toHaveBeenCalled();
    expect(harness.approveRequest).not.toHaveBeenCalled();

    const metadata = harness.publish.mock.calls.at(-1)?.[0] as {
      screenId: string;
      deadEnd: { remedyActionId: string } | null;
    };
    expect(metadata.screenId).toBe("one_location_people");
    expect(metadata.deadEnd?.remedyActionId).toBe("location.add_connections");
  });

  it("renders connected people by server name and navigates row actions with ?person=", async () => {
    harness.listRecipientsPage.mockResolvedValue({
      items: [PRIYA],
      page: 1,
      hasMore: false,
      totalCount: 1,
    });
    render(<LocationPeople />);
    const row = await screen.findByTestId("location-person-row");
    expect(row).toHaveTextContent("Priya Sharma");
    expect(row).toHaveTextContent("Family");
    expect(row).not.toHaveTextContent("u2");

    // The People row carries only Ask and Share. Check-In lives on the Now
    // tab and the nearby flow, so its button must not render here.
    const actions = screen.getByRole("group", {
      name: "Actions for Priya Sharma",
    });
    expect(actions.querySelectorAll("button")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Check in with Priya Sharma" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Ask Priya Sharma for their location",
      }),
    );
    expect(harness.push).toHaveBeenLastCalledWith(
      "/one/location?action=ask&person=u2",
      {
        scroll: false,
      },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Share your location with Priya Sharma",
      }),
    );
    expect(harness.push).toHaveBeenLastCalledWith(
      "/one/location?action=share&person=u2",
      {
        scroll: false,
      },
    );
    expect(harness.requestAccess).not.toHaveBeenCalled();
  });

  it("highlights the person named by ?person=", async () => {
    harness.listRecipientsPage.mockResolvedValue({
      items: [PRIYA, { ...PRIYA, userId: "u9", displayName: "Rahul Verma" }],
      page: 1,
      hasMore: false,
      totalCount: 2,
    });
    render(<LocationPeople focusedUserId="u9" />);
    const rows = await screen.findAllByTestId("location-person-row");
    expect(rows).toHaveLength(2);
    const focused = rows.find(
      (row) => row.getAttribute("data-person-focused") === "true",
    );
    expect(focused).toHaveTextContent("Rahul Verma");
  });

  it("approves and withdraws real pending requests from state", async () => {
    harness.listRecipientsPage.mockResolvedValue({
      items: [PRIYA],
      page: 1,
      hasMore: false,
      totalCount: 1,
    });
    harness.getState.mockResolvedValue({
      ...EMPTY_STATE,
      requests: [
        {
          id: "r-in",
          ownerUserId: "me",
          requesterUserId: "u3",
          requesterDisplayName: "Arjun Mehta",
          status: "pending",
          requestedDurationHours: 2,
        },
        {
          id: "r-out",
          ownerUserId: "u2",
          requesterUserId: "me",
          ownerDisplayName: "Priya Sharma",
          status: "pending",
        },
      ],
    });
    harness.approveRequest.mockResolvedValue({
      request: { id: "r-in", status: "approved" },
      grant: { id: "g-new" },
    });
    harness.withdrawRequest.mockResolvedValue({
      id: "r-out",
      status: "cancelled",
    });

    render(<LocationPeople />);
    const incoming = await screen.findByTestId("location-people-incoming-row");
    expect(incoming).toHaveTextContent("Arjun Mehta");
    expect(incoming).toHaveTextContent("2 hours");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(harness.approveRequest).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        requestId: "r-in",
        approvalMode: "manual",
      }),
    );

    const outgoing = screen.getByTestId("location-people-outgoing-row");
    expect(outgoing).toHaveTextContent("Priya Sharma");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await waitFor(() =>
      expect(harness.withdrawRequest).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        requestId: "r-out",
      }),
    );
  });
});
