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
import { CIRCLE_MEMBER_MENU_CLASSNAME } from "@/components/one-location/redesign/circles/circle-member-row-layout";
import { ROUTES } from "@/lib/navigation/routes";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
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
    onConnectMember: vi.fn(async () => undefined),
    onLeave: vi.fn(),
    onDelete: vi.fn(),
  };
}

describe("named Circle flows", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders viewer-relative contact provenance in a Circle roster", async () => {
    const onLoad = vi.fn(async () => ({
      ...circle("circle-1", "Family"),
      memberCount: 2,
      members: [
        ...circle("circle-1", "Family").members,
        {
          userId: "contact-user",
          displayName: "Asha Contact",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "connected" as const,
          connectedFromContacts: true,
        },
      ],
    }));

    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("Asha Contact")).toBeTruthy();
    expect(screen.getByLabelText("Connected from your contacts")).toBeTruthy();
  });

  it("uses bounded member pages and keeps duplicate names addressable by user id", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "Legacy"));
    const onLoadOverview = vi.fn(async () => ({
      ...circle("circle-1", "Family"),
      members: undefined,
      memberCount: 5000,
    }));
    const onLoadMembersPage = vi.fn(
      async (
        _circleId: string,
        options: { page: number; limit: number; query?: string },
      ) => ({
        items:
          options.query === "nobody"
            ? []
            : options.page === 1
              ? [
                  {
                    userId: "same-1",
                    displayName: "Same Name",
                    role: "member" as const,
                    phoneVerified: true,
                    secureLocationReady: true,
                  },
                ]
              : [
                  {
                    userId: "same-2",
                    displayName: "Same Name",
                    role: "member" as const,
                    phoneVerified: true,
                    secureLocationReady: true,
                    connectedFromContacts: true,
                  },
                ],
        page: options.page,
        hasMore: options.page === 1,
        totalCount: options.query === "nobody" ? 0 : 5000,
      }),
    );

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onLoadOverview={onLoadOverview}
        onLoadMembersPage={onLoadMembersPage}
      />,
    );

    expect(await screen.findByText("Same Name")).toBeTruthy();
    expect(onLoad).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByTestId("one-location-circle-members-load-more"),
    );
    await waitFor(() =>
      expect(screen.getAllByText("Same Name")).toHaveLength(2),
    );
    expect(screen.getByLabelText("Connected from your contacts")).toBeTruthy();
    expect(onLoadMembersPage).toHaveBeenCalledWith(
      "circle-1",
      expect.objectContaining({ page: 2, limit: 50 }),
    );

    fireEvent.change(screen.getByLabelText("Search members"), {
      target: { value: "nobody" },
    });
    await waitFor(() =>
      expect(screen.getByText("No members found")).toBeTruthy(),
    );
    const retainedSearch = screen.getByLabelText("Search members");
    expect(retainedSearch).toHaveValue("nobody");
    fireEvent.change(retainedSearch, { target: { value: "" } });
    expect(screen.getByLabelText("Search members")).toHaveValue("");
  }, 15000);

  it("creates a typed Circle and keeps a failed submission recoverable", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Circle limit reached."))
      .mockResolvedValueOnce(undefined);

    render(<CreateCircleFlow busy={false} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("e.g. Family"), {
      target: { value: "Meena Family" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Circle" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Circle limit reached."),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Circle" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith("Meena Family", "family");
  });

  it("blocks Create only while the name is empty, and says so visibly", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CreateCircleFlow busy={false} onSubmit={onSubmit} />);

    const create = screen.getByRole("button", { name: "Create Circle" });
    const input = screen.getByPlaceholderText("e.g. Family");

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
              photoUrl: "https://cdn.example.test/asha-circle.jpg",
              connectionOrigin: "one" as const,
              connectedFromContacts: true,
              isRia: true,
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

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    expect(await screen.findByText("Asha Meena")).toBeTruthy();
    const ashaRow = screen.getByTestId("one-location-circle-eligible-conn-1");
    expect(
      ashaRow.querySelector(
        '[data-photo-url="https://cdn.example.test/asha-circle.jpg"]',
      ),
    ).toBeTruthy();
    expect(within(ashaRow).getByLabelText("Verified advisor")).toBeTruthy();
    expect(
      within(ashaRow).getByLabelText("Connected from your contacts"),
    ).toBeTruthy();

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
      <JoinCircleFlow busy={false} onResolve={onResolve} onJoin={onJoin} />,
    );

    fireEvent.change(screen.getByLabelText("Circle invite code"), {
      target: {
        value: "Join my BEST TEAM EVER Circle on One with code 2345-6789-ABCD.",
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
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith("2345-6789-ABCD"));
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
      ((value: OneLocationCircleInvitePreview) => void) | undefined;
    let resolveSecond:
      ((value: OneLocationCircleInvitePreview) => void) | undefined;
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
      <JoinCircleFlow busy={false} onResolve={onResolve} onJoin={onJoin} />,
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
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith("BCDE-FGHJ-KMNP"));
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
    const view = render(<CircleDetailFlow circleId="circle-one" {...props} />);

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
      screen.queryByText(/Join first\. Sharing stays private\./i),
    ).toBeNull();
    const joinButton = screen.getByRole("button", { name: "Join" });
    fireEvent.click(joinButton);
    fireEvent.click(joinButton);
    await waitFor(() =>
      expect(onAcceptInvite).toHaveBeenCalledWith("invite-1"),
    );
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

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
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

    fireEvent.click(screen.getByRole("button", { name: /Asha Meena/i }));
    expect(
      screen.getByRole("button", {
        name: /Asha Meena/i,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Neel Shah/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 people" }));

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
    expect(screen.getByRole("button", { name: "Add people" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replace code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete circle" })).toBeNull();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    expect(screen.getByRole("button", { name: "Leave circle" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Invite code/i }));
    expect(await screen.findByText(inviteCode.code)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    fireEvent.click(screen.getByRole("button", { name: "Share invite" }));
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
        name: /Friend User/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));
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

    expect(await screen.findByText("Family")).toBeTruthy();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete circle" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Invite code/i }));
    expect(await screen.findByText(currentCode.code)).toBeTruthy();
    const inviteCodeSheet = screen.getByRole("dialog", {
      name: "Invite code",
    });
    fireEvent.click(
      within(inviteCodeSheet).getByRole("button", { name: "Replace code" }),
    );
    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "Replace invite code?",
    });
    expect(confirmDialog.closest('[data-slot="sheet-content"]')).toBeNull();
    expect(confirmDialog).toHaveClass("z-[714]");
    expect(
      document.querySelector('[data-slot="alert-dialog-overlay"]'),
    ).toHaveClass("z-[713]");
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Replace code" }),
    );

    await waitFor(() =>
      expect(onGenerateCode).toHaveBeenCalledWith("circle-1", true),
    );
    expect(await screen.findByText(rotatedCode.code)).toBeTruthy();
  });

  it("dismisses only the replace-code confirmation and keeps the invite sheet close button responsive", async () => {
    const currentCode = {
      id: "code-1",
      circleId: "circle-1",
      code: "2345-6789-ABCD",
      expiresAt: "2026-08-01T00:00:00Z",
    };
    const ownerCircle = {
      ...circle("circle-1", "Family"),
      activeInviteCode: currentCode,
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
      />,
    );

    expect(await screen.findByText("Family")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Invite code/i }));
    expect(await screen.findByText(currentCode.code)).toBeTruthy();

    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Invite code" })).getByRole(
        "button",
        { name: "Replace code" },
      ),
    );
    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "Replace invite code?",
    });
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("alertdialog", { name: "Replace invite code?" }),
      ).toBeNull();
    });
    const inviteCodeSheet = screen.getByRole("dialog", {
      name: "Invite code",
    });
    fireEvent.click(
      within(inviteCodeSheet).getByRole("button", { name: "Close" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Invite code" })).toBeNull();
    });
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
      await screen.findByRole("button", { name: /Invite code/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Create code" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    expect(await screen.findByText("Asha Meena")).toBeTruthy();

    const asha = screen.getByRole("button", {
      name: /Asha Meena/i,
    });
    const neel = screen.getByRole("button", {
      name: /Neel Shah/i,
    });
    expect(asha).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(asha);
    expect(asha).toHaveAttribute("aria-pressed", "true");
    expect(neel).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add 1 person" })).toBeEnabled();
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

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    expect(await screen.findByText("No room left in this Circle")).toBeTruthy();
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

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    const asha = await screen.findByRole("button", {
      name: /Asha Meena/i,
    });
    fireEvent.click(asha);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));

    await waitFor(() =>
      expect(onLoadEligibleConnections).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByText("Asha Meena")).toBeNull();
    expect(await screen.findByText("Neel Shah")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Neel Shah/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      within(screen.getByRole("dialog", { name: "Add people" })).getByRole(
        "button",
        { name: "Add people" },
      ),
    ).toBeDisabled();
  });

  it("opens a quiet rename sheet, then shows the new name without refetching", async () => {
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

    expect(await screen.findByText("Meena Family")).toBeTruthy();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = (await screen.findByLabelText(
      "Circle name",
    )) as HTMLInputElement;

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
    // Saved state closes the sheet back to the quiet edit affordance.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
    );
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("keeps rename controls out of the steady-state Circle detail page", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "Meena Family"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("Meena Family")).toBeTruthy();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const save = await screen.findByRole("button", { name: "Save" });
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

    await screen.findByText("Meena Family");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = (await screen.findByLabelText(
      "Circle name",
    )) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Typed then abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByLabelText("Circle name")).toBeNull(),
    );
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const nextInput = (await screen.findByLabelText(
      "Circle name",
    )) as HTMLInputElement;
    fireEvent.change(nextInput, { target: { value: "Meena Home" } });
    fireEvent.keyDown(nextInput, { key: "Enter" });
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

  it("spends a roster row's trailing edge only on relationships the viewer can act on", async () => {
    const onConnectMember = vi.fn(async () => undefined);
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          userId: "known-user",
          displayName: "Divya Rajendran",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "connected" as const,
        },
        {
          userId: "stranger-user",
          displayName: "Sharu Khan",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "none" as const,
        },
        {
          userId: "waiting-user",
          displayName: "Asha Meena",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "pending_outgoing" as const,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onConnectMember={onConnectMember}
      />,
    );

    await screen.findByText("Divya Rajendran");

    // Already connected is the steady state of a roster, so it is said to the
    // accessibility tree and to nothing else. A grey, disabled, button-shaped
    // "Connected" beside every name was the report this row was rebuilt for.
    expect(screen.queryByRole("button", { name: /^Connected$/ })).toBeNull();
    expect(screen.queryByTestId("circle-member-connect-known-user")).toBeNull();

    // Waiting on them is news, but nothing here can advance it: a status, not
    // a control.
    expect(
      screen.getByTestId("circle-member-relationship-waiting-user").tagName,
    ).toBe("SPAN");
    expect(
      screen.queryByTestId("circle-member-connect-waiting-user"),
    ).toBeNull();

    // The one row with something to ask for keeps a real, pressable control.
    const connect = screen.getByTestId("circle-member-connect-stranger-user");
    expect(connect).toHaveAccessibleName("Connect with Sharu Khan");
    fireEvent.click(connect);
    await waitFor(() =>
      // The identity rides along, because the caller puts this person in
      // front of the same capability review the Connect directory opens, and
      // that sheet has to name who the request is going to.
      expect(onConnectMember).toHaveBeenCalledWith(
        "circle-1",
        "stranger-user",
        { displayName: "Sharu Khan", photoUrl: null },
      ),
    );
  });

  it("sends an incoming request to where it can actually be answered", async () => {
    const onConnectMember = vi.fn(async () => undefined);
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          userId: "asked-user",
          displayName: "Neel Shah",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "pending_incoming" as const,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onConnectMember={onConnectMember}
      />,
    );

    // This used to be an ENABLED button whose handler ran only for
    // `action === "connect"`, so the single row with something waiting on it
    // offered the one control on the screen that did nothing at all.
    const respond = await screen.findByTestId(
      "circle-member-respond-asked-user",
    );
    // The consent centre, not `/one/connect`. From a Circle hosted ON Connect,
    // a bare `/one/connect` href is a navigation whose only change is the query
    // string disappearing -- which the App Router refuses -- so the one row
    // with something waiting on it did nothing at all when tapped. A different
    // pathname works from either host, and it is where Connect's own Respond
    // already goes.
    const href = respond.getAttribute("href") ?? "";
    expect(href).not.toBe(ROUTES.CONNECT);
    expect(href).toBe(buildConsentCenterHref("pending"));
    fireEvent.click(respond);
    expect(onConnectMember).not.toHaveBeenCalled();
  });

  it("holds the roster's action column open on rows that have no menu", async () => {
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          userId: "ready-user",
          displayName: "Ready Ronnie",
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
      />,
    );

    await screen.findByText("Ready Ronnie");

    // The viewer's own row has neither Share (self) nor Remove (owner), and
    // used to render nothing at all there — so the kebab column stepped in and
    // out by 44px from row to row down the list.
    const spacers = screen.getAllByTestId("circle-member-menu-spacer");
    expect(spacers).toHaveLength(1);
    expect(spacers[0].className).toContain(CIRCLE_MEMBER_MENU_CLASSNAME);
    expect(spacers[0]).toHaveAttribute("aria-hidden", "true");
  });

  // Reported on a Trusted Circle reading "Ankit Kumar Singh / JHUMMA KUMARI
  // (You · Owner) / Neelesh Meena" -- the roster was A-Z, and the owner is
  // whoever the alphabet puts in the middle. "Owner hamesha sabse upar hi
  // rahega, sabhi kind ke circles ke liye", so both kinds are asserted here
  // rather than only the one that was photographed.
  it.each([
    ["a Trusted Circle", "trusted" as const],
    ["an ordinary Circle", null],
  ])("puts the owner at the top of %s", async (_label, systemKind) => {
    const roster = {
      ...circle("circle-1", systemKind === "trusted" ? "Trusted" : "Family"),
      systemKind,
      memberCount: 3,
      members: [
        {
          userId: "ankit-user",
          displayName: "Ankit Kumar Singh",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
        // Alphabetically between the two members, which is exactly where the
        // report found them.
        {
          userId: "owner-user",
          displayName: "Jhumma Kumari",
          role: "owner" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
        {
          userId: "neelesh-user",
          displayName: "Neelesh Meena",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => roster)}
      />,
    );

    const owner = await screen.findByText("Jhumma Kumari");
    for (const memberName of ["Ankit Kumar Singh", "Neelesh Meena"]) {
      expect(
        owner.compareDocumentPosition(screen.getByText(memberName)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    // A partition, not a re-sort: the two members keep the A-Z order they
    // had underneath the owner.
    expect(
      screen
        .getByText("Ankit Kumar Singh")
        .compareDocumentPosition(screen.getByText("Neelesh Meena")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("stops hoisting the owner once the roster is answering a search", async () => {
    // The owner leads a ROSTER. A searched list is answering a question, and
    // both search paths rank a name that begins with the query above one that
    // merely contains it -- hoisting the owner through that would put the
    // wrong person first on the one screen where the reader has already said
    // who they want. "Ankit Kumar Singh" and "Jhumma Kumari" both have a word
    // beginning with "ku", so A-Z inside the rank decides, and Ankit wins.
    const filler = Array.from({ length: 7 }, (_unused, index) => ({
      userId: `filler-${index}`,
      displayName: `Zz Filler ${index}`,
      role: "member" as const,
      phoneVerified: true,
      secureLocationReady: true,
    }));

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ({
          ...circle("circle-1", "Family"),
          memberCount: 9,
          members: [
            {
              userId: "owner-user",
              displayName: "Jhumma Kumari",
              role: "owner" as const,
              phoneVerified: true,
              secureLocationReady: true,
            },
            {
              userId: "ankit-user",
              displayName: "Ankit Kumar Singh",
              role: "member" as const,
              phoneVerified: true,
              secureLocationReady: true,
            },
            ...filler,
          ],
        }))}
      />,
    );

    fireEvent.change(await screen.findByPlaceholderText("Search members"), {
      target: { value: "ku" },
    });

    const ankit = await screen.findByText("Ankit Kumar Singh");
    expect(
      ankit.compareDocumentPosition(screen.getByText("Jhumma Kumari")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Reported on the Add people sheet: "extra space between the section is
  // bad", "search bahut jyada neeche aa raha", "divs truncated bhi dikh rahe
  // hain". None of that gap was written here -- it was SheetContent's `gap-4`,
  // SheetHeader's `p-4`, the body's `mt-4` and SettingsGroup's `mt-7`, four
  // sensible defaults stacking. Asserted on the rendered classes rather than
  // measured, because jsdom has no layout: what regressed was which owner's
  // default is in force, and that is exactly what these read back.
  it("does not stack four owners' default spacing above the Add people list", async () => {
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Family"))}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            { userId: "conn-1", displayName: "Asha Meena" },
            { userId: "conn-2", displayName: "Neel Shah" },
          ],
          pendingInvites: [],
          remainingCapacity: 5,
        }))}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    const sheet = await screen.findByRole("dialog", { name: "Add people" });

    // The header stops adding a second inset on top of the sheet's own, so
    // the title lines up with the search field instead of sitting inboard of
    // it, and stops adding 16px under a description the gap already spaced.
    const header = sheet.querySelector('[data-slot="sheet-header"]');
    expect(header?.className).toContain("p-0");
    expect(header?.className).not.toContain("p-4");

    const group = await screen.findByTestId(
      "one-location-circle-eligible-connections",
    );
    const headingBlock = group
      .querySelector('[data-slot="settings-group-heading"]')
      ?.closest("section > div");
    expect(headingBlock?.className).toContain("mt-0");
    expect(headingBlock?.className).not.toContain("mt-7");

    // And the list is still the thing that scrolls, so the "Add N people"
    // button cannot be pushed off the bottom by a long roster.
    const scroller = sheet.querySelector(".overflow-y-auto.overscroll-contain");
    expect(scroller).not.toBeNull();
    expect(scroller?.contains(group)).toBe(true);
  });

  it("scopes quick actions to the row's own member and hides actions that don't apply", async () => {
    const onShareWithMember = vi.fn();
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          // Share-ready member: both menu actions apply.
          userId: "ready-user",
          displayName: "Ready Ronnie",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
        {
          // Not phone-verified yet: Share is invalid and must not appear,
          // even though Remove still does.
          userId: "pending-user",
          displayName: "Pending Priya",
          role: "member" as const,
          phoneVerified: false,
          secureLocationReady: false,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onShareWithMember={onShareWithMember}
      />,
    );

    // The owner row (viewer, not removable, share excluded as self) gets no
    // overflow trigger at all — nothing valid to act on.
    await screen.findByText("Ready Ronnie");
    expect(
      screen.queryByRole("button", { name: "Actions for Owner" }),
    ).toBeNull();

    // Pending Priya cannot yet receive a share: only Remove is offered.
    const priyaTrigger = screen.getByRole("button", {
      name: "Actions for Pending Priya",
    });
    fireEvent.keyDown(priyaTrigger, { key: "Enter" });
    expect(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Share location/i }),
    ).toBeNull();
    fireEvent.keyDown(document.activeElement ?? priyaTrigger, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: /Remove from Circle/i }),
      ).toBeNull(),
    );

    // Ready Ronnie's row offers both, and triggering Share calls back with
    // exactly Ronnie's id — not a stale id left over from another row.
    const ronnieTrigger = screen.getByRole("button", {
      name: "Actions for Ready Ronnie",
    });
    fireEvent.keyDown(ronnieTrigger, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Share location/i }),
    );
    expect(onShareWithMember).toHaveBeenCalledWith("circle-1", "ready-user");
    expect(onShareWithMember).not.toHaveBeenCalledWith(
      "circle-1",
      "pending-user",
    );
  });

  it("filters the Members list by name, case-insensitively, and shows an empty state for no match", async () => {
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
        ...Array.from({ length: 7 }, (_, index) => ({
          userId: `extra-user-${index}`,
          displayName: `Circle Member ${index}`,
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        })),
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
      />,
    );

    await screen.findByText("John Smith");
    expect(screen.getByText("You · Owner")).toBeInTheDocument();

    const search = screen.getByPlaceholderText("Search members");

    // Partial, uppercase query — filtering is instant on every keystroke and
    // case never matters, same contract as the Add People connection search.
    fireEvent.change(search, { target: { value: "JOH" } });
    expect(screen.getByText("John Smith")).toBeInTheDocument();
    expect(screen.queryByText("You · Owner")).not.toBeInTheDocument();

    // Zero matches gets a real empty state, not a blank list.
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(await screen.findByText("No members found")).toBeInTheDocument();
    expect(screen.queryByText("John Smith")).not.toBeInTheDocument();

    // Clearing the query restores the original, unfiltered roster.
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("John Smith")).toBeInTheDocument();
    expect(screen.getByText("You · Owner")).toBeInTheDocument();
    expect(screen.queryByText("No members found")).not.toBeInTheDocument();
  });

  it("bounds the Members list to a scrollable region instead of growing the page indefinitely", async () => {
    const rosterCircle = {
      ...circle("circle-1", "Meena Family"),
      memberLimit: 100,
      members: [
        ...circle("circle-1", "Meena Family").members,
        ...Array.from({ length: 80 }, (_, index) => ({
          userId: `member-${index}`,
          displayName: `Synced Contact ${index}`,
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        })),
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => rosterCircle)}
      />,
    );

    await screen.findByText("Synced Contact 0");

    // "Delete circle" sits after the roster in source order; it must still
    // mount even with 81 rows above it, because the roster scrolls inside
    // its own bounded region instead of pushing the rest of the page down.
    expect(
      screen.getByRole("button", { name: "Delete circle" }),
    ).toBeInTheDocument();

    const membersGroup = screen.getByTestId("one-location-circle-members");
    const shell = membersGroup.querySelector(
      '[data-slot="settings-group-shell"]',
    );
    expect(shell?.className).toContain("max-h-[60vh]");
    const scrollRegion = shell?.firstElementChild as HTMLElement | null;
    expect(scrollRegion?.className).toContain("overflow-y-auto");
  });

  it("keeps the member search bar hidden for a small Circle", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "Meena Family"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("You · Owner")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search members")).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: /Asha Meena/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenCalledWith("circle-1", [
        "asha-user",
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add people" })).toBeNull(),
    );

    // Multiple selection — reopening starts from a cleared selection.
    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    fireEvent.click(await screen.findByRole("button", { name: /Asha Meena/i }));
    fireEvent.click(screen.getByRole("button", { name: /Neel Shah/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 people" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenLastCalledWith("circle-1", [
        "asha-user",
        "neel-user",
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add people" })).toBeNull(),
    );
  });

  it("keeps Circle detail invitations within the 20-person API batch", async () => {
    const invitees = Array.from({ length: 21 }, (_, index) => ({
      connectionId: `connection-${index + 1}`,
      userId: `user-${index + 1}`,
      displayName: `Person ${String(index + 1).padStart(2, "0")}`,
    }));
    const onInviteConnections = vi.fn(async () => undefined);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ({
          ...circle("circle-1", "Meena Family"),
          memberLimit: 100,
        }))}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: invitees,
          pendingInvites: [],
          remainingCapacity: 99,
        }))}
        onInviteConnections={onInviteConnections}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    expect(
      await screen.findByText(/Add up to 20 people at a time/i),
    ).toBeTruthy();
    for (const invitee of invitees.slice(0, 20)) {
      fireEvent.click(
        within(
          screen.getByTestId(`one-location-circle-eligible-${invitee.userId}`),
        ).getByRole("button"),
      );
    }
    expect(
      within(
        screen.getByTestId("one-location-circle-eligible-user-21"),
      ).getByRole("button"),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Add 20 people" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenCalledWith(
        "circle-1",
        invitees.slice(0, 20).map((invitee) => invitee.userId),
      ),
    );
  }, 15000);

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
    fireEvent.click(await screen.findByRole("button", { name: /Asha Meena/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Circle capacity changed."),
    );
    expect(screen.getByRole("dialog", { name: "Add people" })).toBeTruthy();
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

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Friend User/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Add people" })).toBeNull(),
    );
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(onLoadEligibleConnections).toHaveBeenCalledTimes(1);
  });
  it("offers a system Circle's owner neither destructive door", async () => {
    // The branch used to be a two-way `isOwner && !isSystem`, so the owner of
    // their own emergency Circle fell through to "Leave circle" -- which
    // `_end_membership` refuses with LOCATION_CIRCLE_OWNER_LEAVE_INVALID every
    // single time. The only control at the bottom of the screen was one that
    // could not work.
    const systemCircle = {
      ...circle("circle-sms", "SMS Circle"),
      isSystem: true,
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: false,
        canRotateInviteCode: false,
        canManageCircle: true,
        canModerateInvites: true,
      },
    };
    render(
      <CircleDetailFlow
        circleId="circle-sms"
        {...detailProps(vi.fn(async () => systemCircle))}
      />,
    );

    expect(await screen.findByText("SMS Circle")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Leave circle/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete circle/i })).toBeNull();
    expect(
      screen.queryByText(/managed for you, so it can.t be left or deleted/i),
    ).toBeNull();
  });

  it("still offers an ordinary Circle's owner the delete door", async () => {
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(vi.fn(async () => circle("circle-1", "Meena Family")))}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /Delete circle/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Leave circle/i })).toBeNull();
  });
});

describe("a Trusted Circle offers no control that cannot work", () => {
  function trustedCircle(): OneLocationCircleDetail {
    return {
      id: "trusted-circle",
      name: "Trusted",
      kind: "other",
      role: "owner",
      memberCount: 2,
      // No ceiling: the connection graph is not capped.
      memberLimit: null,
      isSystem: false,
      systemKind: "trusted",
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: false,
        canRotateInviteCode: false,
        canManageCircle: true,
        canModerateInvites: true,
        canDeleteCircle: false,
        canLeaveCircle: false,
      },
      members: [
        {
          userId: "owner-user",
          displayName: "Owner",
          role: "owner",
          phoneVerified: true,
          secureLocationReady: true,
        },
        {
          userId: "member-user",
          displayName: "Asha",
          role: "member",
          phoneVerified: true,
          secureLocationReady: true,
        },
      ],
    };
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows neither Delete nor Leave", async () => {
    // Trusted is deliberately NOT `is_system`, so the guard written for the SMS
    // Circle -- `isOwner && circle.isSystem` -- let it fall through to a Delete
    // button that the API and a database trigger both refuse.
    const onLoad = vi.fn(async () => trustedCircle());
    render(
      <CircleDetailFlow circleId="trusted-circle" {...detailProps(onLoad)} />,
    );

    await screen.findByText("Trusted");
    expect(screen.queryByRole("button", { name: /Delete circle/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Leave circle/i })).toBeNull();
    expect(
      screen.queryByText(/Everyone you're connected to is in this Circle/i),
    ).toBeNull();
    expect(screen.queryByText(/choose who is in it/i)).toBeNull();
  });

  it("offers no Remove on its roster, because disconnecting is the way out", async () => {
    // `_end_membership` refuses a removal here with
    // LOCATION_CIRCLE_TRUSTED_FOLLOWS_CONNECTION: membership is derived from
    // the connection, so a removal would be undone by the next reconcile.
    const onLoad = vi.fn(async () => trustedCircle());
    render(
      <CircleDetailFlow circleId="trusted-circle" {...detailProps(onLoad)} />,
    );

    await screen.findByText("Asha");
    expect(
      screen.queryByRole("button", { name: /Remove from Circle/i }),
    ).toBeNull();
    expect(screen.queryByText(/Remove Asha\?/i)).toBeNull();
  });

  it("still lets an ordinary Circle's owner remove a member", async () => {
    // The narrowing is about Trusted, not about rosters in general.
    const ordinary = { ...trustedCircle(), systemKind: null, id: "circle-1" };
    ordinary.viewerCapabilities = {
      ...ordinary.viewerCapabilities!,
      canDeleteCircle: true,
      canLeaveCircle: false,
    };
    const onLoad = vi.fn(async () => ordinary as OneLocationCircleDetail);
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    await screen.findByText("Asha");
    expect(screen.getByRole("button", { name: /Delete circle/i })).toBeTruthy();
  });
});

describe("a roster row can take back a request it sent", () => {
  function circleWithPending(): OneLocationCircleDetail {
    return {
      id: "circle-1",
      name: "K Family",
      kind: "family",
      role: "owner",
      memberCount: 2,
      memberLimit: 100,
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
        {
          userId: "waiting-user",
          displayName: "Sharu Khan",
          role: "member",
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "pending_outgoing",
        },
      ],
    } as OneLocationCircleDetail;
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("offers Cancel where the caller can act, not a dead status", async () => {
    // The Connect directory has always offered Cancel on exactly this row
    // state. The roster showed the same fact -- "Requested" -- with nothing to
    // do about it, so the two screens disagreed about what a pending request
    // is: news on one, a decision you can still change on the other.
    const onCancelMemberRequest = vi.fn(async () => undefined);
    const onLoad = vi.fn(async () => circleWithPending());
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onCancelMemberRequest={onCancelMemberRequest}
      />,
    );

    const cancel = await screen.findByTestId(
      "circle-member-cancel-waiting-user",
    );
    expect(cancel).toBeTruthy();
    // And the bare status is gone, so the row carries one control, not both.
    expect(
      screen.queryByTestId("circle-member-relationship-waiting-user"),
    ).toBeNull();

    fireEvent.click(cancel);
    await waitFor(() =>
      expect(onCancelMemberRequest).toHaveBeenCalledWith(
        "circle-1",
        "waiting-user",
      ),
    );
  });

  it("falls back to the status where the caller cannot cancel", async () => {
    // A surface with no cancel of its own must not grow a button that does
    // nothing. The Location hub is that surface today.
    const onLoad = vi.fn(async () => circleWithPending());
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(
      await screen.findByTestId("circle-member-relationship-waiting-user"),
    ).toHaveTextContent("Requested");
    expect(
      screen.queryByTestId("circle-member-cancel-waiting-user"),
    ).toBeNull();
  });
});

describe("a caller-requested re-read keeps the screen where it was", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("re-reads on a bumped signal", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "K Family"));
    const props = detailProps(onLoad);
    const view = render(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={0} />,
    );
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));

    view.rerender(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={1} />,
    );

    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
  });

  it("does not re-read when the signal has not moved", async () => {
    // Every unrelated re-render must not put a request on the wire.
    const onLoad = vi.fn(async () => circle("circle-1", "K Family"));
    const props = detailProps(onLoad);
    const view = render(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={3} />,
    );
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));

    view.rerender(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={3} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});

describe("an impatient second tap never makes a second Circle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates once however many times Create is pressed", async () => {
    // The host clears its busy flag in a `finally`, which runs before the
    // navigation it then starts has committed -- so there is a guaranteed
    // render with this form still mounted, the name still in state and the
    // button live again. Two taps made two identically-named Circles and two
    // success toasts.
    let release: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );

    render(<CreateCircleFlow busy={false} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("e.g. Family"), {
      target: { value: "Roommates" },
    });
    const create = screen.getByRole("button", { name: /create/i });
    fireEvent.click(create);
    fireEvent.click(create);
    fireEvent.click(create);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    release?.();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("lets a failed create be retried", async () => {
    // The guard must not outlive a failure, or one server hiccup makes the
    // form permanently dead with the name still typed into it.
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(undefined);

    render(<CreateCircleFlow busy={false} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Family"), {
      target: { value: "Roommates" },
    });
    const create = screen.getByRole("button", { name: /create/i });

    fireEvent.click(create);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    fireEvent.click(create);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });
});

describe("a Circle with only the current user stays compact", () => {
  function emptyCircle(
    systemKind: "trusted" | "sms" | null,
    canInvite = true,
  ): OneLocationCircleDetail {
    return {
      id: "circle-1",
      name: systemKind === "trusted" ? "Trusted" : "SMS Circle",
      kind: "other",
      role: "owner",
      memberCount: 1,
      memberLimit: systemKind === "trusted" ? null : 100,
      isSystem: systemKind === "sms",
      systemKind,
      viewerCapabilities: {
        // What the server actually sends: Trusted's roster is derived, so
        // nobody may add to it by hand -- `is_owner and not is_trusted`.
        canInviteMembers: systemKind === "trusted" ? false : canInvite,
        canViewInviteCode: systemKind === null,
        canRotateInviteCode: systemKind === null,
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
    } as OneLocationCircleDetail;
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not blame a search the person never ran", async () => {
    // Both branches used to be one, so a Circle with nobody in it said
    // "No members found · Try a different name" and offered nothing. Three
    // Circles reach this state without being asked for -- the SMS Circle and
    // Trusted arrive on their own, and onboarding makes one more -- so it is
    // the first thing many people ever see here.
    const onLoad = vi.fn(async () => emptyCircle("sms"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("You · Owner")).toBeTruthy();
    expect(screen.queryByText("No one's in this Circle yet")).toBeNull();
    expect(screen.queryByText("Try a different name.")).toBeNull();
  });

  it("offers the Invite row without a second identical empty-state button", async () => {
    // A Circle you can add to already has an "Add people" card on this screen.
    // A second identical button is not a second option, it is the same one
    // twice -- and it made "Add people" ambiguous to anything looking for it.
    const onLoad = vi.fn(async () => emptyCircle("sms"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    await screen.findByText("SMS Circle");
    expect(screen.getAllByRole("button", { name: /Add people/i })).toHaveLength(
      1,
    );
    expect(
      screen.queryByTestId("one-location-circle-empty-find-people"),
    ).toBeNull();
  });

  it("does not show manual add controls when the Circle fills itself", async () => {
    // Trusted's roster follows the connection, so there is nothing to add by
    // hand -- the way to fill it is to connect with somebody.
    const onLoad = vi.fn(async () => emptyCircle("trusted"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("Trusted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add people/i })).toBeNull();
    expect(
      screen.queryByTestId("one-location-circle-empty-find-people"),
    ).toBeNull();
  });

  it("keeps the owner row when the reader cannot act", async () => {
    const onLoad = vi.fn(async () => emptyCircle("sms", false));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("You · Owner")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add people/i })).toBeNull();
  });

});
