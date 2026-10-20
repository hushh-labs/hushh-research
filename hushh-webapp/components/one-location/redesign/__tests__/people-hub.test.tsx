// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PeopleHub,
  type LocationHubViewModel,
} from "@/components/one-location/redesign/location-redesign-hub";
import { isShareReadyRecipient } from "@/lib/one-location/share-recipient-selection";
import type {
  OneLocationAccessRequest,
  OneLocationGrant,
  OneLocationRecipient,
} from "@/lib/one-location/types";

const recipient: OneLocationRecipient = {
  userId: "owner_roopmann",
  displayName: "Roopmann V",
} as OneLocationRecipient;

const activeGrant: OneLocationGrant = {
  id: "grant_live",
  ownerUserId: "owner_roopmann",
  recipientUserId: "viewer_jhumma",
  recipientKeyId: "key_viewer",
  status: "active",
  consentScope: "cap.location.live.view",
  capabilityScopes: ["cap.location.live.view"],
  durationHours: 1,
  createdAt: "2026-08-25T00:20:00.000Z",
  expiresAt: "2026-08-25T01:05:00.000Z",
  durationMode: "timed",
} as OneLocationGrant;

const approvedRequest: OneLocationAccessRequest = {
  id: "request_approved",
  ownerUserId: "owner_roopmann",
  requesterUserId: "viewer_jhumma",
  status: "approved",
  requestedAt: "2026-08-25T00:00:00.000Z",
  approvedGrantId: activeGrant.id,
  requestedDurationHours: 1,
  requestedDurationMode: "timed",
} as OneLocationAccessRequest;

function vm(overrides: Partial<LocationHubViewModel> = {}): LocationHubViewModel {
  return {
    userId: "viewer_jhumma",
    canShare: true,
    busy: null,
    revokingGrantId: null,
    withdrawingRequestId: null,
    requestedByMe: [approvedRequest],
    circles: [],
    incomingCircleMemberInvites: [],
    incomingCircleMemberInvitesLoading: false,
    incomingCircleMemberInvitesError: null,
    incomingCircleMemberInviteFocusResolved: true,
    recipients: [recipient],
    visibleRecipients: [recipient],
    recipientSearch: "",
    setRecipientSearch: vi.fn(),
    onSyncContacts: vi.fn(),
    activeOwnerGrants: [],
    receivedGrants: [activeGrant],
    expiresCountdownLabel: () => "Stops in 42 min",
    recipientLabel: (row: OneLocationRecipient) => row.displayName ?? "Person",
    recipientSubtitle: () => "Existing trust or sharing history makes this a strong match.",
    isRecipientShareReady: () => true,
    requestOwnerLabel: () => "Roopmann V",
    editingGrantId: activeGrant.id,
    savingGrantId: null,
    requestingMoreTimeKey: null,
    onEditGrantStart: vi.fn(),
    onEditGrantCancel: vi.fn(),
    editGrantDurationHours: "1",
    setEditGrantDurationHours: vi.fn(),
    onEditGrantSave: vi.fn(),
    onRequestMoreTime: vi.fn().mockResolvedValue(undefined),
    onWithdrawRequest: vi.fn(),
    onStopGrant: vi.fn(),
    onShowMyLocation: vi.fn(),
    onHideMyLocation: vi.fn(),
    onResumeMyLocation: vi.fn(),
    onAutoApproveRequestsChange: vi.fn(),
    onRequestPermission: vi.fn(),
    onOpenLocationSettings: vi.fn(),
    onOpenShareReview: vi.fn(),
    onEnterShareConfirm: vi.fn(),
    onConfirmShare: vi.fn(),
    onSendRequest: vi.fn().mockResolvedValue(true),
    onAskReshare: vi.fn(),
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onViewGrant: vi.fn(),
    toggleRequestOwner: vi.fn(),
    ...overrides,
  } as unknown as LocationHubViewModel;
}

describe("PeopleHub requests sent manage surface", () => {
  function renderPeopleHub({
    viewModel = vm(),
    onStartShare = vi.fn(),
    onStartAsk = vi.fn(),
    onOpenSharedWithMe = vi.fn(),
    onOpenActiveShares = vi.fn(),
    onAddConnections = vi.fn(),
    onInvite = vi.fn(),
  }: {
    viewModel?: LocationHubViewModel;
    onStartShare?: ReturnType<typeof vi.fn>;
    onStartAsk?: ReturnType<typeof vi.fn>;
    onOpenSharedWithMe?: ReturnType<typeof vi.fn>;
    onOpenActiveShares?: ReturnType<typeof vi.fn>;
    onAddConnections?: ReturnType<typeof vi.fn>;
    onInvite?: ReturnType<typeof vi.fn>;
  } = {}) {
    render(
      <PeopleHub
        vm={viewModel}
        onAddConnections={onAddConnections}
        onInvite={onInvite}
        onOpenCircleManager={vi.fn()}
        focusedInviteId={null}
        onDismissFocusedInvite={vi.fn()}
        onStartShare={onStartShare}
        onStartAsk={onStartAsk}
        onOpenActiveShares={onOpenActiveShares}
        onOpenSharedWithMe={onOpenSharedWithMe}
      />,
    );
    return {
      onStartShare,
      onStartAsk,
      onOpenSharedWithMe,
      onOpenActiveShares,
      onAddConnections,
      onInvite,
    };
  }

  it("uses the Connect avatar renderer for Location people rows", () => {
    renderPeopleHub({
      viewModel: vm({
          requestedByMe: [],
          receivedGrants: [],
          editingGrantId: null,
          visibleRecipients: [
            {
              ...recipient,
              photoUrl: "https://cdn.example.test/roopmann-location.jpg",
              isRia: true,
            },
          ],
        }),
    });

    const peopleList = screen.getByTestId("one-location-people-list");
    expect(
      peopleList.querySelector(
        '[data-photo-url="https://cdn.example.test/roopmann-location.jpg"]',
      ),
    ).toBeTruthy();
    expect(
      within(peopleList).getByLabelText("Verified advisor"),
    ).toBeInTheDocument();
  });

  it("opens received-location actions from the row instead of inline controls", () => {
    const onOpenSharedWithMe = vi.fn();
    const onStartShare = vi.fn();
    renderPeopleHub({ onOpenSharedWithMe, onStartShare });

    expect(screen.getByText("Sharing with you · 42 min left")).toBeTruthy();
    expect(screen.queryByText("Ask for more time")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop viewing" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Open Location actions for Roopmann V/i,
      }),
    );

    expect(
      screen.getByRole("dialog", { name: "Roopmann V" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View their location" }));
    expect(onOpenSharedWithMe).toHaveBeenCalled();
    expect(onStartShare).not.toHaveBeenCalled();
  });

  it("hands neutral people to the existing Share and Ask composers", () => {
    const onStartShare = vi.fn();
    const onStartAsk = vi.fn();
    renderPeopleHub({
      viewModel: vm({
        requestedByMe: [],
        receivedGrants: [],
        editingGrantId: null,
      }),
      onStartShare,
      onStartAsk,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Location actions for Roopmann V",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Share my location" }));
    expect(onStartShare).toHaveBeenCalledWith("owner_roopmann");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Location actions for Roopmann V",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask for location" }));
    expect(onStartAsk).toHaveBeenCalledWith("owner_roopmann");
  });

  it("keeps inline Ask and Share as independent, accessible actions", () => {
    const onStartShare = vi.fn();
    const onStartAsk = vi.fn();
    const readyRecipient = {
      ...recipient,
      canReceiveLocation: true,
      keyId: "recipient-key",
      publicKeyJwk: { kty: "EC" },
    };
    renderPeopleHub({
      viewModel: vm({
        requestedByMe: [],
        receivedGrants: [],
        editingGrantId: null,
        recipients: [readyRecipient],
        visibleRecipients: [readyRecipient],
        isRecipientShareReady: isShareReadyRecipient,
      }),
      onStartShare,
      onStartAsk,
    });

    const peopleList = screen.getByTestId("one-location-people-list");
    const group = within(peopleList).getByRole("group", {
      name: "Actions for Roopmann V",
    });
    expect(within(group).getAllByRole("button").map((button) => button.textContent?.trim()))
      .toEqual(["Share", "Ask"]);
    fireEvent.click(within(group).getByRole("button", {
      name: "Ask Roopmann V for their location",
    }));
    fireEvent.click(within(group).getByRole("button", {
      name: "Share your location with Roopmann V",
    }));

    expect(group.querySelector("svg")).toBeNull();
    expect(onStartAsk).toHaveBeenCalledExactlyOnceWith("owner_roopmann");
    expect(onStartShare).toHaveBeenCalledExactlyOnceWith("owner_roopmann");
    expect(peopleList.querySelector("button button")).toBeNull();
  });

  it.each([
    { canReceiveLocation: false, keyId: "recipient-key", publicKeyJwk: { kty: "EC" } },
    { canReceiveLocation: true, keyId: null, publicKeyJwk: { kty: "EC" } },
    { canReceiveLocation: true, keyId: "recipient-key", publicKeyJwk: null },
  ])("explains blocked sharing and offers recovery without opening Share: %j", (readiness) => {
    const blockedRecipient = { ...recipient, ...readiness };
    const { onStartShare, onStartAsk, onInvite } = renderPeopleHub({
      viewModel: vm({
        requestedByMe: [],
        receivedGrants: [],
        editingGrantId: null,
        recipients: [blockedRecipient],
        visibleRecipients: [blockedRecipient],
        isRecipientShareReady: isShareReadyRecipient,
      }),
    });

    const share = within(screen.getByTestId("one-location-people-list"))
      .getByRole("button", { name: "Share your location with Roopmann V" });
    expect(share).toBeEnabled();
    expect(share).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(share);

    const dialog = screen.getByRole("dialog", { name: "Roopmann V" });
    expect(within(dialog).getByText(
      "Roopmann V is connected on One. They need to open One before they can receive your location.",
    )).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Share my location" })).toBeNull();
    expect(onStartShare).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("button", { name: "Invite to One" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Manage connection" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask for location" }));
    expect(onStartAsk).toHaveBeenCalledExactlyOnceWith("owner_roopmann");
    expect(onInvite).not.toHaveBeenCalled();
    expect(onStartShare).not.toHaveBeenCalled();
  });

  it("keeps the Circles summary free of stacked system identity icons", () => {
    renderPeopleHub({
      viewModel: vm({
        circles: [
          { id: "a", name: "Family", memberCount: 3, role: "owner" },
          { id: "b", name: "Friends", memberCount: 5, role: "owner" },
          { id: "c", name: "Neighbors", memberCount: 4, role: "owner" },
          { id: "d", name: "Team", memberCount: 6, role: "member" },
        ] as LocationHubViewModel["circles"],
      }),
    });

    const summary = screen.getByTestId("one-location-circles-summary");
    expect(summary.querySelector("[data-circle-identity-stack]")).toBeNull();
    expect(summary.querySelector("[data-circle-overflow-count]")).toBeNull();
    expect(within(summary).getByText("Circles")).toBeTruthy();
    expect(within(summary).getByText("3 created · 1 joined")).toBeTruthy();
  });

  it("keeps the mobile add-people sheet named without a visible People header", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });

    try {
      renderPeopleHub();
      const trigger = screen.getByRole("button", {
        name: "Add or manage people",
      });
      fireEvent.click(trigger);

      const sheet = await screen.findByTestId("one-location-add-people-sheet");
      const accessibleTitle = within(sheet).getByRole("heading", {
        name: "People",
      });
      expect(accessibleTitle).toHaveClass("sr-only");
      expect(sheet.querySelector('[data-slot="sheet-header"]')).toBeNull();
      expect(
        within(sheet).getByRole("button", { name: "Find contacts" }),
      ).toBeTruthy();
      expect(
        within(sheet).getByRole("button", { name: "Invite to One" }),
      ).toBeTruthy();
      expect(
        within(sheet).getByRole("button", { name: "Manage connections" }),
      ).toBeTruthy();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
    }
  });

  it("keeps pending request cancellation in the person actions sheet", () => {
    const pendingRequest = {
      ...approvedRequest,
      id: "request_pending",
      status: "pending",
      extendsGrantId: undefined,
    } as OneLocationAccessRequest;
    const onWithdrawRequest = vi.fn();
    renderPeopleHub({
      viewModel: vm({
        requestedByMe: [pendingRequest],
        receivedGrants: [],
        editingGrantId: null,
        onWithdrawRequest,
      }),
    });

    expect(screen.getByText("Waiting for response")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Requests sent" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Open Location actions for Roopmann V/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    expect(onWithdrawRequest).toHaveBeenCalledWith("request_pending");
  });
});
