// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";


import { CheckInFlow } from "@/components/one-location/redesign/check-in-flow";
import type { LocationHubViewModel } from "@/components/one-location/redesign/location-redesign-hub";
import type { CircleRecipientSelection } from "@/lib/one-location/circle-recipient-selection";
import type { OneLocationRecipient } from "@/lib/one-location/types";

const readyCircleRecipient: OneLocationRecipient = {
  userId: "family-member",
  displayName: "Ankit",
  phoneVerified: true,
  keyId: "key-family-member",
  publicKeyJwk: { kty: "EC" },
  keyAlgorithm: "ECDH-P256-AES256-GCM", // gitleaks:allow - public algorithm identifier
  canReceiveLocation: true,
};

const familySelection: CircleRecipientSelection = {
  circle: {
    id: "circle-family",
    name: "Family",
    kind: "family",
    role: "owner",
    memberCount: 3,
    memberLimit: 20,
    members: [
      {
        userId: "owner",
        displayName: "You",
        role: "owner",
        phoneVerified: true,
        secureLocationReady: true,
      },
      {
        userId: readyCircleRecipient.userId,
        displayName: readyCircleRecipient.displayName,
        role: "member",
        phoneVerified: true,
        secureLocationReady: true,
        canReceiveLocation: true,
        keyId: readyCircleRecipient.keyId,
        publicKeyJwk: readyCircleRecipient.publicKeyJwk,
        keyAlgorithm: readyCircleRecipient.keyAlgorithm,
      },
      {
        userId: "setup-needed",
        displayName: "Neelesh",
        role: "member",
        phoneVerified: true,
        secureLocationReady: false,
      },
    ],
  },
  ready: [
    {
      recipient: {
        ...readyCircleRecipient,
        keyId: readyCircleRecipient.keyId!,
        publicKeyJwk: readyCircleRecipient.publicKeyJwk!,
      },
      sourceCircleId: "circle-family",
    },
  ],
  excluded: [
    {
      member: {
        userId: "owner",
        displayName: "You",
        role: "owner",
        phoneVerified: true,
        secureLocationReady: true,
      },
      reason: "self",
      label: "You are not added as a recipient",
    },
    {
      member: {
        userId: "setup-needed",
        displayName: "Neelesh",
        role: "member",
        phoneVerified: true,
        secureLocationReady: false,
      },
      reason: "location_setup_needed",
      label: "Location setup is not complete",
    },
  ],
};

function buildViewModel(
  overrides: Partial<LocationHubViewModel> = {},
): LocationHubViewModel {
  return {
    busy: null,
    circles: [
      {
        id: "circle-family",
        name: "Family",
        kind: "family",
        role: "owner",
        memberCount: 3,
        memberLimit: 20,
      },
    ],
    sosRecipients: [],
    myLocationPoint: {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracyM: 8,
      capturedAt: "2026-07-29T12:00:00.000Z",
      sourcePlatform: "web",
    },
    myLocationError: null,
    onResolveNamedCircleRecipients: vi
      .fn()
      .mockResolvedValue(familySelection),
    onShareNamedCircleCodeById: vi.fn().mockResolvedValue(undefined),
    onLoadNamedCircleEligibleConnections: vi.fn().mockResolvedValue({
      eligibleConnections: [],
      pendingInvites: [],
      remainingCapacity: 0,
    }),
    onInviteNamedCircleConnections: vi.fn().mockResolvedValue(undefined),
    onCancelNamedCircleMemberInvite: vi.fn().mockResolvedValue(undefined),
    onCheckIn: vi.fn(),
    onShowMyLocation: vi.fn(),

    recipientLabel: (recipient) => recipient.displayName,
    isRecipientShareReady: (recipient) =>
      Boolean(
        recipient.canReceiveLocation &&
          recipient.keyId &&
          recipient.publicKeyJwk,
      ),
    formatDateTime: () => "12:00 PM",
    renderMapPreview: () => <div>Map preview</div>,
    ...overrides,
  } as LocationHubViewModel;
}

describe("CheckInFlow Circle targeting", () => {
  it("resolves the selected Circle and checks in with its current ready members", async () => {
    const onCheckIn = vi.fn();
    const onResolveNamedCircleRecipients = vi
      .fn()
      .mockResolvedValue(familySelection);
    const vm = buildViewModel({
      onCheckIn,
      onResolveNamedCircleRecipients,
    });

    render(<CheckInFlow vm={vm} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Family/i }));

    await waitFor(() => {
      expect(onResolveNamedCircleRecipients).toHaveBeenCalledWith(
        "circle-family",
        "location",
      );
      expect(screen.getByText("1 ready now")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Current ready members only/i),
    ).toHaveTextContent("1 not ready.");

    fireEvent.click(
      screen.getByRole("button", { name: "Check in with 1 person" }),
    );

    expect(onCheckIn).toHaveBeenCalledWith(
      ["family-member"],
      "1",
      "I've checked in here, let's catch up",
      "circle-family",
    );
  });

  it("lets a user grow the selected Circle by sharing its invite code", async () => {
    const onShareNamedCircleCodeById = vi.fn().mockResolvedValue(undefined);
    const vm = buildViewModel({ onShareNamedCircleCodeById });

    render(<CheckInFlow vm={vm} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Family/i }));
    const grow = await screen.findByTestId("check-in-circle-grow-actions");
    fireEvent.click(
      within(grow).getByRole("button", { name: /Share code/i }),
    );

    await waitFor(() =>
      expect(onShareNamedCircleCodeById).toHaveBeenCalledWith("circle-family"),
    );
  });
});

