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
import { CIRCLE_NAME_ACTION_CLASSNAME } from "@/components/one-location/redesign/circles/circle-name-row-layout";
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

  it("blocks Create only while the name is empty, and says so visibly", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CreateCircleFlow busy={false} onSubmit={onSubmit} />);

    const create = screen.getByRole("button", { name: "Create circle" });
    const input = screen.getByPlaceholderText("e.g. Meena Family");

    // Nothing typed: the button is genuinely blocked, and it is painted as a
    // neutral fill rather than a half-opacity accent that still reads as live.
    expect(create).toBeDisabled();
    expect(create.className).toContain("disabled:bg-black/10");
    expect(create.className).toContain("disabled:opacity-100");

    // Whitespace is not a name.
    fireEvent.change(input, { target: { value: "   " } });
    expect(create).toBeDisabled();

    // One character is.
    fireEvent.change(input, { target: { value: "A" } });
    expect(create).toBeEnabled();

    fireEvent.click(create);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("A", "family"));
  });

  it("finds a connection from the first letter of any of their names", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "Meena Family"));
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            {
              userId: "conn-1",
              displayName: "Asha Meena",
              connectionOrigin: "one" as const,
            },
            {
              userId: "conn-2",
              displayName: "Neel Shah",
              connectionOrigin: "one" as const,
            },
          ],
          pendingInvites: [],
          remainingCapacity: 5,
        }))}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Add people" }),
    );
    expect(await screen.findByText("Asha Meena")).toBeTruthy();

    // "Asha Meena" and "Neel Shah" BOTH contain an "n", so a substring filter
    // returned both and one-letter search looked broken. Only Neel's name
    // BEGINS with one.
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "n" },
    });
    expect(screen.getByText("Neel Shah")).toBeTruthy();
    expect(screen.queryByText("Asha Meena")).toBeNull();

    // A later word counts as a beginning too.
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "m" },
    });
    expect(screen.getByText("Asha Meena")).toBeTruthy();
    expect(screen.queryByText("Neel Shah")).toBeNull();
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

  it("pre-fills the code input from initialCode (a shared /circle/join link)", () => {
    render(
      <JoinCircleFlow
        busy={false}
        initialCode="2345-6789-ABCD"
        onResolve={async () => ({}) as OneLocationCircleInvitePreview}
        onJoin={async () => undefined}
      />,
    );

    expect(screen.getByLabelText("Circle invite code")).toHaveValue(
      "2345-6789-ABCD",
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
    expect(screen.getByText(/Join first\. Sharing stays private\./i)).toBeTruthy();
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

  it("offers an inline Save only once the Circle name is edited, then shows the new name everywhere", async () => {
    const onRename = vi.fn(async (circleId: string, name: string) =>
      circle(circleId, name),
    );
    const onLoad = vi.fn(async () => circle("circle-1", "Meena Family"));

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onRename={onRename}
      />,
    );

    const input = (await screen.findByLabelText(
      "Circle name",
    )) as HTMLInputElement;
    // Untouched: no edit affordance is needed, and the trailing slot is never
    // a write until the name actually changes.
    expect(
      screen.getByTestId("one-location-circle-name-placeholder"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    // Only an empty name blocks the write; one character is a name.
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Enter a name.")).toBeTruthy();

    fireEvent.change(input, { target: { value: "M" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    fireEvent.change(input, { target: { value: "  Meena Home  " } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith("circle-1", "Meena Home"),
    );
    // Header, the delete confirmation copy and the add-people sheet all read the
    // renamed Circle without waiting for a refetch.
    expect(await screen.findByText("Meena Home")).toBeTruthy();
    expect(input.value).toBe("Meena Home");
    // Saved state collapses back to the reserved placeholder.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
    );
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("gives Save and the placeholder one box, so the field never resizes mid-edit", async () => {
    // QA: "Save CTA, not looking good". The cause was measurable. Save took
    // `Button`'s `default` size, whose `min-h-[50px]` outlives an `h-11` --
    // `h-` and `min-h-` are separate tailwind-merge groups -- so it rendered
    // 50px against a 44px field. And because Save is wider than the reserved
    // slot beside it, letting them differ resized the input on the first
    // keystroke.
    //
    // JSDOM cannot see either of those; it applies no CSS. What it can prove is
    // that both states are handed the one shared class string that
    // `e2e/connect-circle-cta.layout.spec.ts` measured at 44px and a fixed
    // width, on Chromium and on WebKit.
    const onLoad = vi.fn(async () => circle("circle-1", "Meena Family"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    const input = (await screen.findByLabelText(
      "Circle name",
    )) as HTMLInputElement;

    const placeholder = screen.getByTestId(
      "one-location-circle-name-placeholder",
    );
    expect(placeholder.className).toContain(CIRCLE_NAME_ACTION_CLASSNAME);

    fireEvent.change(input, { target: { value: "Meena Home" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.className).toContain(CIRCLE_NAME_ACTION_CLASSNAME);

    // The height override is only load-bearing with its `min-h` partner.
    const tokens = new Set(CIRCLE_NAME_ACTION_CLASSNAME.split(/\s+/));
    expect(tokens.has("h-11")).toBe(true);
    expect(tokens.has("min-h-11")).toBe(true);

    // A word alone. The check mark beside "Save" said the same thing twice and
    // pulled the button's padding in through `has-[>svg]`.
    expect(save.querySelector("svg")).toBeNull();
    expect(save.textContent).toBe("Save");
  });

  it("saves the Circle name on Enter and reverts it on Escape", async () => {
    const onRename = vi.fn(async (circleId: string, name: string) =>
      circle(circleId, name),
    );

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onRename={onRename}
      />,
    );

    const input = (await screen.findByLabelText(
      "Circle name",
    )) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Typed then abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("Meena Family");
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Meena Home" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith("circle-1", "Meena Home"),
    );
  });

  it("removes a member from a labelled destructive menu action, behind a labelled overflow trigger", async () => {
    const onRemoveMember = vi.fn(async () => undefined);
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          userId: "friend-user",
          displayName: "John Smith",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onRemoveMember={onRemoveMember}
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "Actions for John Smith",
    });
    // Radix opens DropdownMenuTrigger on pointerdown (no PointerEvent in
    // jsdom) or on Enter/Space keydown — use the keyboard path here.
    fireEvent.keyDown(trigger, { key: "Enter" });

    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove", hidden: true }),
    );
    await waitFor(() =>
      expect(onRemoveMember).toHaveBeenCalledWith("circle-1", "friend-user"),
    );
  });

  it("closes the add-people sheet after inviting, for one person or many", async () => {
    const eligibility = {
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
      remainingCapacity: 2,
    };
    const onInviteConnections = vi.fn(async () => undefined);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={vi.fn(async () => eligibility)}
        onInviteConnections={onInviteConnections}
      />,
    );

    // Single selection.
    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Asha Meena Connected on One/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite 1 person" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenCalledWith("circle-1", [
        "asha-user",
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByText("Add people to Meena Family")).toBeNull(),
    );

    // Multiple selection — reopening starts from a cleared selection.
    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Asha Meena Connected on One/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Neel Shah Connected on One/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite 2 people" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenLastCalledWith("circle-1", [
        "asha-user",
        "neel-user",
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByText("Add people to Meena Family")).toBeNull(),
    );
  });

  it("keeps the sheet open when sending fails so the selection can be retried", async () => {
    const onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [
        {
          connectionId: "connection-1",
          userId: "asha-user",
          displayName: "Asha Meena",
        },
      ],
      pendingInvites: [],
      remainingCapacity: 1,
    }));

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

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Asha Meena Connected on One/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite 1 person" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Circle capacity changed."),
    );
    expect(screen.getByText("Add people to Meena Family")).toBeTruthy();
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
