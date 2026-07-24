// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import {
  CircleDetailFlow,
  CreateCircleFlow,
  JoinCircleFlow,
} from "@/components/one-location/redesign/circles/named-circle-flows";
import type {
  OneLocationCircleDetail,
  OneLocationCircleInvitePreview,
} from "@/lib/one-location/types";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
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

  it("previews before joining and states that membership does not share location", async () => {
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
      screen.getByText(/does not share your current or live location/i),
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
});
