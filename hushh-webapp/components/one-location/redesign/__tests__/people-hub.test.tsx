// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
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
  it("uses quick extension actions instead of the old duration editor", () => {
    render(
      <PeopleHub
        vm={vm()}
        onAddConnections={vi.fn()}
        onInvite={vi.fn()}
        onCreateCircle={vi.fn()}
        onJoinCircle={vi.fn()}
        onOpenCircle={vi.fn()}
        focusedInviteId={null}
        onDismissFocusedInvite={vi.fn()}
        onStartShare={vi.fn()}
      />,
    );

    expect(screen.getByText("Sharing with you · 42 min left")).toBeTruthy();
    expect(screen.getByText("Ask for more time")).toBeTruthy();
    expect(screen.getByRole("button", { name: "30 min more" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2 hours more" })).toBeTruthy();
    expect(screen.getByText("They’ll need to approve.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop viewing" })).toBeTruthy();
    expect(screen.queryByText("New duration")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("sends the selected extension amount with the active grant id", () => {
    const onRequestMoreTime = vi.fn().mockResolvedValue(undefined);
    render(
      <PeopleHub
        vm={vm({ onRequestMoreTime })}
        onAddConnections={vi.fn()}
        onInvite={vi.fn()}
        onCreateCircle={vi.fn()}
        onJoinCircle={vi.fn()}
        onOpenCircle={vi.fn()}
        focusedInviteId={null}
        onDismissFocusedInvite={vi.fn()}
        onStartShare={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "30 min more" }));
    expect(onRequestMoreTime).toHaveBeenCalledWith({
      ownerUserId: "owner_roopmann",
      grantId: "grant_live",
      ownerLabel: "Roopmann V",
      additionalHours: 0.5,
    });
  });

  it("shows pending extension state and keeps Take back wired", () => {
    const pendingExtension = {
      ...approvedRequest,
      id: "request_extension",
      status: "pending",
      extendsGrantId: activeGrant.id,
      requestedDurationHours: 2,
    } as OneLocationAccessRequest;
    const onWithdrawRequest = vi.fn();
    render(
      <PeopleHub
        vm={vm({
          requestedByMe: [approvedRequest, pendingExtension],
          onWithdrawRequest,
        })}
        onAddConnections={vi.fn()}
        onInvite={vi.fn()}
        onCreateCircle={vi.fn()}
        onJoinCircle={vi.fn()}
        onOpenCircle={vi.fn()}
        focusedInviteId={null}
        onDismissFocusedInvite={vi.fn()}
        onStartShare={vi.fn()}
      />,
    );

    expect(screen.getByText("2 hours more requested")).toBeTruthy();
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "30 min more" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(onWithdrawRequest).toHaveBeenCalledWith("request_extension");
  });
});
