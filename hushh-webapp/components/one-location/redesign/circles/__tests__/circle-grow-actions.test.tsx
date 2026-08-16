// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CircleGrowActions,
  CircleInvitePeopleSheet,
} from "@/components/one-location/redesign/circles/circle-grow-actions";
import { BLOCKED_CTA } from "@/components/one-location/redesign/circles/blocked-cta";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function growProps() {
  return {
    circleId: "circle-1",
    circleName: "Meena Family",
    onShareCode: vi.fn().mockResolvedValue(undefined),
    onLoadEligibleConnections: vi.fn().mockResolvedValue({
      eligibleConnections: [
        {
          connectionId: "conn-1",
          userId: "asha-user",
          displayName: "Asha Meena",
        },
      ],
      pendingInvites: [],
      remainingCapacity: 1,
    }),
    onInviteConnections: vi.fn().mockResolvedValue(undefined),
    onCancelMemberInvite: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CircleGrowActions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shares the invite code by id", async () => {
    const props = growProps();
    render(<CircleGrowActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /Share code/i }));

    await waitFor(() =>
      expect(props.onShareCode).toHaveBeenCalledWith("circle-1"),
    );
  });

  it("opens the invite sheet and sends a member invitation", async () => {
    const props = growProps();
    render(<CircleGrowActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /Invite people/i }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Asha Meena Connected on One/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite 1 person" }));

    await waitFor(() =>
      expect(props.onInviteConnections).toHaveBeenCalledWith("circle-1", [
        "asha-user",
      ]),
    );
  });

  it("hides Invite people for members without invite capability but keeps Share code", () => {
    const props = growProps();
    render(<CircleGrowActions {...props} canInvite={false} />);

    expect(
      screen.queryByRole("button", { name: /Invite people/i }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Share code/i }),
    ).toBeTruthy();
  });
});

describe("CircleInvitePeopleSheet", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("paints its blocked Select people CTA the same as the Circle detail copy", async () => {
    // This sheet exists twice — here, reached from Check-In, and in the Circle
    // detail flow. A user meeting the same sheet by a different route must not
    // see a different button, so both read the one BLOCKED_CTA definition.
    render(
      <CircleInvitePeopleSheet
        open
        onOpenChange={vi.fn()}
        circleId="circle-1"
        circleName="Meena Family"
        onLoadEligibleConnections={vi.fn().mockResolvedValue({
          eligibleConnections: [
            {
              userId: "conn-1",
              displayName: "Asha Meena",
              connectionOrigin: "one" as const,
            },
          ],
          pendingInvites: [],
          remainingCapacity: 5,
        })}
        onInviteConnections={vi.fn().mockResolvedValue(undefined)}
        onCancelMemberInvite={vi.fn()}
      />,
    );

    const cta = await screen.findByRole("button", { name: "Select people" });
    expect(cta).toBeDisabled();
    for (const rule of BLOCKED_CTA.split(" ")) {
      expect(cta.className).toContain(rule);
    }
    // The half-opacity accent fill is what made a blocked button read as live.
    expect(cta.className).not.toContain("disabled:opacity-50");
  });

  it("finds a connection from the first letter here too", async () => {
    render(
      <CircleInvitePeopleSheet
        open
        onOpenChange={vi.fn()}
        circleId="circle-1"
        circleName="Meena Family"
        onLoadEligibleConnections={vi.fn().mockResolvedValue({
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
        })}
        onInviteConnections={vi.fn().mockResolvedValue(undefined)}
        onCancelMemberInvite={vi.fn()}
      />,
    );

    expect(await screen.findByText("Asha Meena")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "n" },
    });
    expect(screen.getByText("Neel Shah")).toBeTruthy();
    expect(screen.queryByText("Asha Meena")).toBeNull();
  });

  it("cancels a pending invitation and reloads eligibility", async () => {
    const onCancelMemberInvite = vi.fn().mockResolvedValue(undefined);
    const onLoadEligibleConnections = vi.fn().mockResolvedValue({
      eligibleConnections: [],
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
      remainingCapacity: 1,
    });

    render(
      <CircleInvitePeopleSheet
        open
        onOpenChange={vi.fn()}
        circleId="circle-1"
        circleName="Meena Family"
        onLoadEligibleConnections={onLoadEligibleConnections}
        onInviteConnections={vi.fn().mockResolvedValue(undefined)}
        onCancelMemberInvite={onCancelMemberInvite}
      />,
    );

    expect(await screen.findByText("Pending Friend")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(onCancelMemberInvite).toHaveBeenCalledWith("pending-1"),
    );
    await waitFor(() =>
      expect(onLoadEligibleConnections).toHaveBeenCalledTimes(2),
    );
  });
});
