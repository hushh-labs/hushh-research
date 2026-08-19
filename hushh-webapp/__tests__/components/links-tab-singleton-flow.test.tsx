import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LinksHub, type LocationHubViewModel } from "@/components/one-location/redesign/location-redesign-hub";

function mockHubViewModel(overrides?: Partial<LocationHubViewModel>): LocationHubViewModel {
  return {
    userId: "user_123",
    canShare: true,
    busy: null,
    revokingGrantId: null,
    withdrawingRequestId: null,
    shareCompletedTick: 0,
    readiness: { tone: "ready", title: "Ready", description: "Location is active" },
    permissionIsPrompt: false,
    locationEnabled: true,
    locationBlocked: false,
    autoApproveRequestsEnabled: false,
    locationPaused: false,
    locationAccuracyLimited: false,
    locationAcquiring: false,
    myLocationPoint: null,
    myLocationError: null,
    recipients: [],
    circles: [],
    selectedShareCircleSelection: null,
    incomingCircleMemberInvites: [],
    incomingCircleMemberInvitesLoading: false,
    incomingCircleMemberInvitesError: null,
    incomingCircleMemberInviteFocusResolved: true,
    visibleRecipients: [],
    visibleShareRecipients: [],
    activeOwnerGrants: [],
    liveShare: null,
    onLiveShareEnded: vi.fn(),
    receivedGrants: [],
    pendingOwnerRequests: [],
    requestedByMe: [],
    latestActivePublicInvite: null,
    latestActiveCircleInvite: null,
    activityReceipts: [],
    recipientSearch: "",
    shareRecipientSearch: "",
    selectedRecipientIds: [],
    selectedRequestOwnerIds: [],
    shareDurationHours: "0.25",
    shareMessage: "",
    durationHours: "1",
    requestMessage: "",
    shareReviewOpen: false,
    publicInviteUrl: "",
    circleInviteUrl: "",
    setRecipientSearch: vi.fn(),
    setShareRecipientSearch: vi.fn(),
    setShareDurationHours: vi.fn(),
    setShareMessage: vi.fn(),
    setDurationHours: vi.fn(),
    setRequestMessage: vi.fn(),
    setShareReviewOpen: vi.fn(),
    resetShareComposer: vi.fn(),
    startShareComposer: vi.fn(),
    toggleShareRecipient: vi.fn(),
    onSelectShareCircle: vi.fn(),
    onResolveNamedCircleRecipients: vi.fn(),
    toggleRequestOwner: vi.fn(),
    onShowMyLocation: vi.fn(),
    onHideMyLocation: vi.fn(),
    onResumeMyLocation: vi.fn(),
    onAutoApproveRequestsChange: vi.fn(),
    onRequestPermission: vi.fn(),
    onOpenLocationSettings: vi.fn(),
    onSyncContacts: vi.fn(),
    onOpenShareReview: vi.fn(),
    onEnterShareConfirm: vi.fn(),
    onConfirmShare: vi.fn(),
    onSendRequest: vi.fn(),
    onAskReshare: vi.fn(),
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onWithdrawRequest: vi.fn(),
    onViewGrant: vi.fn(),
    onStopGrant: vi.fn(),
    editingGrantId: null,
    savingGrantId: null,
    onEditGrantStart: vi.fn(),
    onEditGrantCancel: vi.fn(),
    editGrantDurationHours: "1",
    setEditGrantDurationHours: vi.fn(),
    onEditGrantSave: vi.fn(),
    liveShareDurationEditing: false,
    liveShareDurationHours: "1",
    setLiveShareDurationHours: vi.fn(),
    liveShareDurationSaving: false,
    onEditLiveShareDurationStart: vi.fn(),
    onEditLiveShareDurationCancel: vi.fn(),
    onSaveLiveShareDuration: vi.fn(),
    onCreatePublicInvite: vi.fn(),
    onCopyPublicInvite: vi.fn(),
    onSharePublicInvite: vi.fn(),
    onRevokePublicInvite: vi.fn(),
    onCreateCircleInvite: vi.fn(),
    onCopyCircleInvite: vi.fn(),
    onShareCircleInvite: vi.fn(),
    onRevokeCircleInvite: vi.fn(),
    onLoadNamedCircle: vi.fn(),
    onCreateNamedCircle: vi.fn(),
    onRenameNamedCircle: vi.fn(),
    onResolveNamedCircleCode: vi.fn(),
    onJoinNamedCircle: vi.fn(),
    onGenerateNamedCircleCode: vi.fn(),
    onCopyNamedCircleCode: vi.fn(),
    onShareNamedCircleCode: vi.fn(),
    onShareNamedCircleCodeById: vi.fn(),
    onRemoveNamedCircleMember: vi.fn(),
    onLoadNamedCircleEligibleConnections: vi.fn(),
    onInviteNamedCircleConnections: vi.fn(),
    onAcceptNamedCircleMemberInvite: vi.fn(),
    onDeclineNamedCircleMemberInvite: vi.fn(),
    onCancelNamedCircleMemberInvite: vi.fn(),
    onRetryNamedCircleMemberInvites: vi.fn(),
    onLeaveNamedCircle: vi.fn(),
    onDeleteNamedCircle: vi.fn(),
    prepareNamedCircleShare: vi.fn(),
    clearNamedCircleShareContext: vi.fn(),
    sosRecipients: [],
    smsRecipients: [],
    smsContactCandidates: [],
    smsContactUserIds: [],
    sosActive: false,
    sosBusy: false,
    sosStartedAtLabel: null,
    sosEmergency: null,
    sosEmergencyStatus: "idle",
    onResolveSosLocation: vi.fn(),
    onTriggerSos: vi.fn(),
    onStopSos: vi.fn(),
    onAddSmsContact: vi.fn(),
    onAddSmsCircle: vi.fn(),
    onRemoveSmsContact: vi.fn(),
    onCheckIn: vi.fn(),
    onDiscardPrivateCheckInOperation: vi.fn(),
    recipientLabel: (r) => r.displayName,
    recipientSubtitle: () => "",
    isRecipientShareReady: () => true,
    requestOwnerLabel: (r) => r.ownerDisplayName || "Someone",
    requesterLabel: (r) => r.requesterDisplayName || "Someone",
    grantRecipientLabel: (g) => g.recipientDisplayName || "Someone",
    grantOwnerLabel: (g) => g.ownerDisplayName || "Someone",
    formatDateTime: () => "5:30 PM",
    expiresLabel: () => "until 5:30 PM",
    expiresCountdownLabel: () => "45 min remaining",
    nowMs: Date.now(),
    renderMapPreview: () => null,
    mapLocationHref: () => "#",
    decryptedPoints: {},
    ...overrides,
  };
}

describe("LinksHub Singleton Public Link UX Model", () => {
  it("Zero-State: removes empty white div box and shows Create Public Link CTA button", () => {
    const onCreateTempLink = vi.fn();
    const vm = mockHubViewModel({ latestActivePublicInvite: null });
    render(<LinksHub vm={vm} onCreateTempLink={onCreateTempLink} />);

    // 1. Verify "No active links" empty box container is REMOVED
    expect(screen.queryByText("No active links")).toBeNull();

    // 2. Verify clean explanation text and "Create Public Link" CTA button exist
    expect(
      screen.getByText("Generate a temporary link to share your live location with anyone outside your Circle."),
    ).toBeTruthy();

    const createBtn = screen.getByRole("button", { name: /Create Public Link/i });
    expect(createBtn).toBeTruthy();

    fireEvent.click(createBtn);
    expect(onCreateTempLink).toHaveBeenCalledTimes(1);
  });

  it("Active-State: renders active link card with live status pill and HIDES Create Public Link CTA button", () => {
    const activeInvite = {
      id: "pub_123",
      inviteUrl: "https://uat.one.hushh.ai/one/location/request/xyz",
      durationHours: 1,
      expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };

    const onCreateTempLink = vi.fn();
    const vm = mockHubViewModel({ latestActivePublicInvite: activeInvite });
    render(<LinksHub vm={vm} onCreateTempLink={onCreateTempLink} />);

    // 1. Verify active link card is rendered with Live status pill and title
    expect(screen.getByText("Live location link")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("45 min remaining · anyone with the link")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();

    // 2. Verify "Create Public Link" CTA button is HIDDEN (enforces single link constraint)
    expect(screen.queryByRole("button", { name: /Create Public Link/i })).toBeNull();
  });

  it("Active-State: tapping active link card invokes onManageTempLink", () => {
    const activeInvite = {
      id: "pub_123",
      inviteUrl: "https://uat.one.hushh.ai/one/location/request/xyz",
      durationHours: 1,
      expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };

    const onCreateTempLink = vi.fn();
    const onManageTempLink = vi.fn();
    const vm = mockHubViewModel({ latestActivePublicInvite: activeInvite });
    render(<LinksHub vm={vm} onCreateTempLink={onCreateTempLink} onManageTempLink={onManageTempLink} />);

    const activeCard = screen.getByRole("button", { name: /Live location link/i });
    fireEvent.click(activeCard);

    // Verify callback was triggered to open edit/manage flow
    expect(onManageTempLink).toHaveBeenCalledTimes(1);
  });
});
