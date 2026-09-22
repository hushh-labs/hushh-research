// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PeopleHub,
  type LocationHubViewModel,
} from "@/components/one-location/redesign/location-redesign-hub";
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
  }: {
    viewModel?: LocationHubViewModel;
    onStartShare?: ReturnType<typeof vi.fn>;
    onStartAsk?: ReturnType<typeof vi.fn>;
    onOpenSharedWithMe?: ReturnType<typeof vi.fn>;
    onOpenActiveShares?: ReturnType<typeof vi.fn>;
    onAddConnections?: ReturnType<typeof vi.fn>;
  } = {}) {
    render(
      <PeopleHub
        vm={viewModel}
        onAddConnections={onAddConnections}
        onInvite={vi.fn()}
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
    renderPeopleHub({
      viewModel: vm({ requestedByMe: [], receivedGrants: [], editingGrantId: null }),
      onStartShare,
      onStartAsk,
    });

    const peopleList = screen.getByTestId("one-location-people-list");
    const group = within(peopleList).getByRole("group", {
      name: "Actions for Roopmann V",
    });
    fireEvent.click(within(group).getByRole("button", {
      name: "Ask Roopmann V for their location",
    }));
    fireEvent.click(within(group).getByRole("button", {
      name: "Share your location with Roopmann V",
    }));

    expect(onStartAsk).toHaveBeenCalledExactlyOnceWith("owner_roopmann");
    expect(onStartShare).toHaveBeenCalledExactlyOnceWith("owner_roopmann");
    expect(peopleList.querySelector("button button")).toBeNull();
  });

  it("places the Circles +N counter outside the two-circle identity stack", () => {
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
    const stack = summary.querySelector("[data-circle-identity-stack]");
    const counter = summary.querySelector("[data-circle-overflow-count]");
    expect(stack?.children).toHaveLength(2);
    expect(counter?.textContent).toBe("+2");
    expect(counter?.parentElement).toBe(stack?.parentElement);
    expect(stack?.contains(counter)).toBe(false);
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
