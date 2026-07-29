// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import {
  CircleDetailFlow,
  CirclesSection,
  CreateCircleFlow,
  JoinCircleFlow,
} from "@/components/one-location/redesign/circles/named-circle-flows";
import type {
  OneLocationCircleDetail,
  OneLocationCircleInvitePreview,
  OneLocationCircleMemberInvite,
} from "@/lib/one-location/types";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function circle(id: string, name: string): OneLocationCircleDetail {
  return {
    id,
    name,
    kind: "family",
    role: "owner",
    memberCount: 1,
    memberLimit: 20,
    viewerCapabilities: {
      canInviteMembers: true,
      canViewInviteCode: true,
      canRotateInviteCode: true,
      canManageCircle: true,
      canModerateInvites: true,
    },
    members: [
      {
        userId: "owner-user",
        displayName: "Owner",
        role: "owner",
        phoneVerified: true,
        secureLocationReady: true,
      },
    ],
  };
}

function detailProps(
  onLoad: (circleId: string) => Promise<OneLocationCircleDetail>,
) {
  return {
    currentUserId: "owner-user",
    busy: false,
    onBack: vi.fn(),
    onLoad,
    onRename: vi.fn(async (circleId: string, name: string) =>
      circle(circleId, name),
    ),
    onGenerateCode: vi.fn(),
    onCopyCode: vi.fn(),
    onShareCode: vi.fn(),
    onShareWithMember: vi.fn(),
    onRemoveMember: vi.fn(),
    onLoadEligibleConnections: vi.fn(async () => ({
      eligibleConnections: [],
      pendingInvites: [],
      remainingCapacity: 0,
    })),
    onInviteConnections: vi.fn(),
    onCancelMemberInvite: vi.fn(),
    onLeave: vi.fn(),
    onDelete: vi.fn(),
  };
}

describe("named Circle flows", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a typed Circle and keeps a failed submission recoverable", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Circle limit reached."))
      .mockResolvedValueOnce(undefined);

    render(<CreateCircleFlow busy={false} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("e.g. Meena Family"), {
      target: { value: "Meena Family" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create circle" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Circle limit reached."),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create circle" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith("Meena Family", "family");
  });

  it("previews before joining and discloses connection and location boundaries", async () => {
    const preview: OneLocationCircleInvitePreview = {
      name: "Meena Family",
      kind: "family",
      ownerDisplayName: "Meena",
      memberCount: 3,
      expiresAt: "2026-07-27T00:00:00Z",
      alreadyMember: false,
    };
    const onResolve = vi.fn(async () => preview);
    const onJoin = vi.fn(async () => undefined);

    render(
      <JoinCircleFlow
        busy={false}
        onResolve={onResolve}
        onJoin={onJoin}
      />,
    );

    fireEvent.change(screen.getByLabelText("Circle invite code"), {
      target: {
        value:
          "Join my BEST TEAM EVER Circle on One with code 2345-6789-ABCD.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview circle" }));

    expect(await screen.findByText("Meena Family")).toBeTruthy();
    expect(
      screen.getByText(/connects you with current and future Circle members/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/location and SMS contacts stay private/i),
    ).toBeTruthy();
    expect(onResolve).toHaveBeenCalledWith("2345-6789-ABCD");

    fireEvent.click(screen.getByRole("button", { name: "Join circle" }));
    await waitFor(() =>
      expect(onJoin).toHaveBeenCalledWith("2345-6789-ABCD"),
    );
  });

  it("ignores a stale preview and joins the exact code that was reviewed", async () => {
    let resolveFirst:
      | ((value: OneLocationCircleInvitePreview) => void)
      | undefined;
    let resolveSecond:
      | ((value: OneLocationCircleInvitePreview) => void)
      | undefined;
    const first = new Promise<OneLocationCircleInvitePreview>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<OneLocationCircleInvitePreview>((resolve) => {
      resolveSecond = resolve;
    });
    const onResolve = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const onJoin = vi.fn(async () => undefined);

    render(
      <JoinCircleFlow
        busy={false}
        onResolve={onResolve}
        onJoin={onJoin}
      />,
    );

    const input = screen.getByLabelText("Circle invite code");
    fireEvent.change(input, { target: { value: "2345-6789-ABCD" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview circle" }));
    fireEvent.change(input, { target: { value: "BCDE-FGHJ-KMNP" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview circle" }));

    await act(async () => {
      resolveSecond?.({
        name: "Reviewed Circle",
        kind: "friends",
        ownerDisplayName: "Owner B",
        memberCount: 2,
        expiresAt: "2026-07-27T00:00:00Z",
        alreadyMember: false,
      });
      await second;
    });
    expect(await screen.findByText("Reviewed Circle")).toBeTruthy();

    await act(async () => {
      resolveFirst?.({
        name: "Stale Circle",
        kind: "family",
        ownerDisplayName: "Owner A",
        memberCount: 4,
        expiresAt: "2026-07-27T00:00:00Z",
        alreadyMember: false,
      });
      await first;
    });
    expect(screen.queryByText("Stale Circle")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Join circle" }));
    await waitFor(() =>
      expect(onJoin).toHaveBeenCalledWith("BCDE-FGHJ-KMNP"),
    );
  });

  it("ignores a stale detail response after the selected Circle changes", async () => {
    let resolveFirst: ((value: OneLocationCircleDetail) => void) | undefined;
    let resolveSecond: ((value: OneLocationCircleDetail) => void) | undefined;
    const first = new Promise<OneLocationCircleDetail>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<OneLocationCircleDetail>((resolve) => {
      resolveSecond = resolve;
    });
    const onLoad = vi.fn((circleId: string) =>
      circleId === "circle-one" ? first : second,
    );
    const props = detailProps(onLoad);
    const view = render(
      <CircleDetailFlow circleId="circle-one" {...props} />,
    );

    view.rerender(<CircleDetailFlow circleId="circle-two" {...props} />);
    await act(async () => {
      resolveSecond?.(circle("circle-two", "Second Circle"));
      await second;
    });
    expect(await screen.findByText("Second Circle")).toBeTruthy();

    await act(async () => {
      resolveFirst?.(circle("circle-one", "Stale Circle"));
      await first;
    });
    expect(screen.queryByText("Stale Circle")).toBeNull();
    expect(screen.getByText("Second Circle")).toBeTruthy();
  });

  it("never calls the detail API for an empty Circle id", async () => {
    const onLoad = vi.fn();

    render(<CircleDetailFlow circleId="" {...detailProps(onLoad)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This Circle link is incomplete.",
    );
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("lets an invited person join or decline without a Connect request", async () => {
    const invite: OneLocationCircleMemberInvite = {
      id: "invite-1",
      circleId: "circle-1",
      circleName: "Meena Family",
      circleKind: "family",
      inviterUserId: "owner-user",
      inviterDisplayName: "Meena",
      inviteeUserId: "friend-user",
      inviteeDisplayName: "Asha",
      status: "pending",
      expiresAt: "2026-07-27T00:00:00Z",
      createdAt: "2026-07-24T00:00:00Z",
    };
    const onAcceptInvite = vi.fn(async () => undefined);
    const onDeclineInvite = vi.fn(async () => undefined);

    const view = render(
      <CirclesSection
        circles={[]}
        incomingInvites={[invite]}
        incomingInvitesLoading={false}
        incomingInvitesError={null}
        focusedInviteId="invite-1"
        focusedInviteResolutionReady
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={onAcceptInvite}
        onDeclineInvite={onDeclineInvite}
        onRetryInvites={vi.fn()}
        onDismissFocusedInvite={vi.fn()}
      />,
    );

    expect(screen.getByText("Meena Family")).toBeTruthy();
    expect(
      screen.getByTestId("one-location-circle-invite-invite-1"),
    ).toHaveAttribute("data-focused", "true");
    expect(
      screen.getByText(/current and future Circle members/i),
    ).toBeTruthy();
    const joinButton = screen.getByRole("button", { name: "Join" });
    fireEvent.click(joinButton);
    fireEvent.click(joinButton);
    await waitFor(() => expect(onAcceptInvite).toHaveBeenCalledWith("invite-1"));
    expect(onAcceptInvite).toHaveBeenCalledTimes(1);

    view.rerender(
      <CirclesSection
        circles={[]}
        incomingInvites={[invite]}
        incomingInvitesLoading={false}
        incomingInvitesError={null}
        focusedInviteId="invite-1"
        focusedInviteResolutionReady
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={onAcceptInvite}
        onDeclineInvite={onDeclineInvite}
        onRetryInvites={vi.fn()}
        onDismissFocusedInvite={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(onDeclineInvite).toHaveBeenCalledWith("invite-1"),
    );
  });

  it("shows a retry action when incoming Circle invitations fail to load", () => {
    const onRetryInvites = vi.fn();

    render(
      <CirclesSection
        circles={[]}
        incomingInvites={[]}
        incomingInvitesLoading={false}
        incomingInvitesError="Check your connection and try again."
        focusedInviteId={null}
        focusedInviteResolutionReady
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={vi.fn()}
        onDeclineInvite={vi.fn()}
        onRetryInvites={onRetryInvites}
        onDismissFocusedInvite={vi.fn()}
      />,
    );

    expect(screen.getByText("Circle invitations unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryInvites).toHaveBeenCalledTimes(1);
  });

  it("keeps cached invites visible beside a background refresh warning", () => {
    render(
      <CirclesSection
        circles={[]}
        incomingInvites={[
          {
            id: "invite-cached",
            circleId: "circle-1",
            circleName: "Cached Family",
            circleKind: "family",
            inviterUserId: "owner-user",
            inviterDisplayName: "Meena",
            inviteeUserId: "friend-user",
            status: "pending",
          },
        ]}
        incomingInvitesLoading={false}
        incomingInvitesError="Check your connection and try again."
        focusedInviteId="invite-cached"
        focusedInviteResolutionReady
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={vi.fn()}
        onDeclineInvite={vi.fn()}
        onRetryInvites={vi.fn()}
        onDismissFocusedInvite={vi.fn()}
      />,
    );

    expect(screen.getByText("Circle invitations unavailable")).toBeTruthy();
    expect(screen.getByText("Cached Family")).toBeTruthy();
    expect(
      screen.getByTestId("one-location-circle-invite-invite-cached"),
    ).toHaveAttribute("data-focused", "true");
  });

  it("shows and dismisses a deep-linked invitation that is no longer pending", () => {
    const onDismissFocusedInvite = vi.fn();
    const section = (focusResolved: boolean) => (
      <CirclesSection
        circles={[]}
        incomingInvites={[]}
        incomingInvitesLoading={false}
        incomingInvitesError={null}
        focusedInviteId="invite-expired"
        focusedInviteResolutionReady={focusResolved}
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={vi.fn()}
        onDeclineInvite={vi.fn()}
        onRetryInvites={vi.fn()}
        onDismissFocusedInvite={onDismissFocusedInvite}
      />
    );
    const view = render(section(false));

    expect(
      screen.queryByText("Circle invitation no longer available"),
    ).toBeNull();
    view.rerender(section(true));
    expect(
      screen.getByText("Circle invitation no longer available"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissFocusedInvite).toHaveBeenCalledTimes(1);
  });

  it("lets an owner search and invite multiple existing connections", async () => {
    const onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [
        {
          connectionId: "connection-1",
          userId: "asha-user",
          displayName: "Asha Meena",
        },
        {
          connectionId: "connection-2",
          userId: "neel-user",
          displayName: "Neel Shah",
        },
      ],
      pendingInvites: [
        {
          id: "pending-1",
          circleId: "circle-1",
          circleName: "Meena Family",
          circleKind: "family" as const,
          inviterUserId: "owner-user",
          inviterDisplayName: "Owner",
          inviteeUserId: "pending-user",
          inviteeDisplayName: "Pending Friend",
          status: "pending",
        },
      ],
      remainingCapacity: 2,
    }));
    const onInviteConnections = vi.fn(async () => undefined);
    const onCancelMemberInvite = vi.fn(async () => undefined);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={onLoadEligibleConnections}
        onInviteConnections={onInviteConnections}
        onCancelMemberInvite={onCancelMemberInvite}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Add people" }),
    );
    expect(await screen.findByText("Asha Meena")).toBeTruthy();
    expect(screen.getByText("Neel Shah")).toBeTruthy();
    expect(screen.getByText("Pending Friend")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "Neel" },
    });
    expect(screen.queryByText("Asha Meena")).toBeNull();
    expect(screen.getByText("Neel Shah")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(onCancelMemberInvite).toHaveBeenCalledWith("pending-1"),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Asha Meena Connected on One/i }),
    );
    expect(
      screen.getByRole("button", {
        name: /Asha Meena Connected on One/i,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      screen.getByRole("button", { name: /Neel Shah Connected on One/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite 2 people" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenCalledWith("circle-1", [
        "asha-user",
        "neel-user",
      ]),
    );
  });

  it("lets a member share the Circle code and invite their own connection", async () => {
    const inviteCode = {
      id: "code-1",
      circleId: "circle-1",
      code: "2345-6789-ABCD",
      expiresAt: "2026-08-01T00:00:00Z",
    };
    const memberCircle = {
      ...circle("circle-1", "Friends"),
      role: "member" as const,
      activeInviteCode: inviteCode,
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: true,
        canRotateInviteCode: false,
        canManageCircle: false,
        canModerateInvites: false,
      },
    };
    const onCopyCode = vi.fn(async () => undefined);
    const onShareCode = vi.fn(async () => undefined);
    const onInviteConnections = vi.fn(async () => undefined);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => memberCircle)}
        currentUserId="member-user"
        onCopyCode={onCopyCode}
        onShareCode={onShareCode}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            {
              connectionId: "connection-1",
              userId: "friend-user",
              displayName: "Friend User",
            },
          ],
          pendingInvites: [],
          remainingCapacity: 1,
        }))}
        onInviteConnections={onInviteConnections}
      />,
    );

    expect(await screen.findByText("Friends")).toBeTruthy();
    expect(screen.getByText(inviteCode.code)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add people" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rotate code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete circle" })).toBeNull();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    expect(screen.getByRole("button", { name: "Leave circle" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" }).parentElement).toHaveClass(
      "grid-cols-1",
      "min-[360px]:grid-cols-2",
    );

    const inviteCard = screen.getByTestId("one-location-circle-invite-card");
    fireEvent.click(within(inviteCard).getByRole("button", { name: "Copy" }));
    fireEvent.click(within(inviteCard).getByRole("button", { name: "Share" }));
    await waitFor(() => {
      expect(onCopyCode).toHaveBeenCalledWith(inviteCode.code);
      expect(onShareCode).toHaveBeenCalledWith(
        expect.objectContaining({ id: "circle-1", role: "member" }),
        inviteCode.code,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Friend User Connected on One/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite 1 person" }));
    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenCalledWith("circle-1", [
        "friend-user",
      ]),
    );
  });

  it("keeps shared-code rotation and Circle management owner-only", async () => {
    const currentCode = {
      id: "code-1",
      circleId: "circle-1",
      code: "2345-6789-ABCD",
      expiresAt: "2026-08-01T00:00:00Z",
    };
    const rotatedCode = {
      ...currentCode,
      id: "code-2",
      code: "BCDE-FGHJ-KMNP",
    };
    const ownerCircle = {
      ...circle("circle-1", "Family"),
      activeInviteCode: currentCode,
    };
    const onGenerateCode = vi.fn(async () => rotatedCode);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onGenerateCode={onGenerateCode}
      />,
    );

    expect(await screen.findByText(currentCode.code)).toBeTruthy();
    expect(screen.getByLabelText("Circle name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete circle" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rotate code" }));

    await waitFor(() =>
      expect(onGenerateCode).toHaveBeenCalledWith("circle-1", true),
    );
    expect(await screen.findByText(rotatedCode.code)).toBeTruthy();
  });

  it("requires an explicit owner refresh for an unreadable legacy code", async () => {
    const refreshedCode = {
      id: "code-2",
      circleId: "circle-1",
      code: "BCDE-FGHJ-KMNP",
      expiresAt: "2026-08-01T00:00:00Z",
    };
    const ownerCircle = {
      ...circle("circle-1", "Family"),
      activeInviteCode: null,
      inviteCodeNeedsOwnerRotation: true,
    };
    const onGenerateCode = vi.fn(async () => refreshedCode);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onGenerateCode={onGenerateCode}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh invite code" }),
    );
    await waitFor(() =>
      expect(onGenerateCode).toHaveBeenCalledWith("circle-1", true),
    );
    expect(await screen.findByText(refreshedCode.code)).toBeTruthy();
  });

  it("caps selection at the Circle's remaining capacity", async () => {
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            {
              connectionId: "connection-1",
              userId: "asha-user",
              displayName: "Asha Meena",
            },
            {
              connectionId: "connection-2",
              userId: "neel-user",
              displayName: "Neel Shah",
            },
          ],
          pendingInvites: [],
          remainingCapacity: 1,
        }))}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Add people" }),
    );
    expect(await screen.findByText(/invite 1 more person right now/i)).toBeTruthy();

    const asha = screen.getByRole("button", {
      name: /Asha Meena Connected on One/i,
    });
    const neel = screen.getByRole("button", {
      name: /Neel Shah Connected on One/i,
    });
    expect(asha).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(asha);
    expect(asha).toHaveAttribute("aria-pressed", "true");
    expect(neel).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Invite 1 person" }),
    ).toBeEnabled();
  });

  it("renders Circle full even if a stale eligible row is returned", async () => {
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            {
              connectionId: "connection-stale",
              userId: "stale-user",
              displayName: "Stale Candidate",
            },
          ],
          pendingInvites: [],
          remainingCapacity: 0,
        }))}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Add people" }),
    );
    expect(await screen.findByText("No invitation slots available")).toBeTruthy();
    expect(screen.queryByText("Stale Candidate")).toBeNull();
  });

  it("reloads eligibility and clears stale selection after send failure", async () => {
    const onLoadEligibleConnections = vi
      .fn()
      .mockResolvedValueOnce({
        eligibleConnections: [
          {
            connectionId: "connection-1",
            userId: "asha-user",
            displayName: "Asha Meena",
          },
        ],
        pendingInvites: [],
        remainingCapacity: 1,
      })
      .mockResolvedValueOnce({
        eligibleConnections: [
          {
            connectionId: "connection-2",
            userId: "neel-user",
            displayName: "Neel Shah",
          },
        ],
        pendingInvites: [],
        remainingCapacity: 1,
      });

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={onLoadEligibleConnections}
        onInviteConnections={vi.fn(async () => {
          throw new Error("Circle capacity changed.");
        })}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Add people" }),
    );
    const asha = await screen.findByRole("button", {
      name: /Asha Meena Connected on One/i,
    });
    fireEvent.click(asha);
    fireEvent.click(screen.getByRole("button", { name: "Invite 1 person" }));

    await waitFor(() =>
      expect(onLoadEligibleConnections).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByText("Asha Meena")).toBeNull();
    expect(await screen.findByText("Neel Shah")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Neel Shah Connected on One/i }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Select people" })).toBeDisabled();
  });

  it("closes invitation controls when server capability is revoked", async () => {
    const memberCircle = {
      ...circle("circle-1", "Friends"),
      role: "member" as const,
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: true,
        canRotateInviteCode: false,
        canManageCircle: false,
        canModerateInvites: false,
      },
    };
    const revokedCircle = {
      ...memberCircle,
      viewerCapabilities: {
        ...memberCircle.viewerCapabilities,
        canInviteMembers: false,
        canViewInviteCode: false,
      },
    };
    const onLoad = vi
      .fn()
      .mockResolvedValueOnce(memberCircle)
      .mockResolvedValueOnce(revokedCircle);
    const onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [
        {
          connectionId: "connection-1",
          userId: "friend-user",
          displayName: "Friend User",
        },
      ],
      pendingInvites: [],
      remainingCapacity: 1,
    }));

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onLoadEligibleConnections={onLoadEligibleConnections}
        onInviteConnections={vi.fn(async () => {
          throw new Error("You are no longer allowed to invite people.");
        })}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Add people" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Friend User Connected on One/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite 1 person" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Add people" })).toBeNull(),
    );
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(onLoadEligibleConnections).toHaveBeenCalledTimes(1);
  });
});
