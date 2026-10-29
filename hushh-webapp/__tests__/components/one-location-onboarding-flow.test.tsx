import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

import {
  OneLocationOnboardingFlow,
} from "@/components/one-location/onboarding/one-location-onboarding-flow";

const INVITE = {
  circleId: "circle-1",
  circleName: "Meena Family",
  code: "ABCDEFGHJKLM",
};

function createProps(
  overrides: Partial<
    React.ComponentProps<typeof OneLocationOnboardingFlow>
  > = {},
): React.ComponentProps<typeof OneLocationOnboardingFlow> {
  return {
    startAt: "welcome",
    currentUserName: "Test User",
    nativeTest: {
      routeId: "/one/location",
      marker: "native-route-one-location",
      authState: "authenticated",
      dataState: "loaded",
    },
    onBack: vi.fn(),
    onComplete: vi.fn(),
    onSkip: vi.fn(),
    mapPoint: { lat: 19.076, lng: 72.8777 },
    onPrepareOnboardingCircleInvite: vi.fn().mockResolvedValue(INVITE),
    onCopyOnboardingCircleCode: vi.fn(),
    onShareOnboardingCircleCode: vi.fn(),
    onPreviewCircleCode: vi.fn().mockResolvedValue({
      name: "Family",
      ownerDisplayName: "Meena",
      memberCount: 3,
      alreadyMember: false,
    }),
    onAcceptCircleCode: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderFlow(
  overrides: Partial<
    React.ComponentProps<typeof OneLocationOnboardingFlow>
  > = {},
) {
  const props = createProps(overrides);
  const view = render(<OneLocationOnboardingFlow {...props} />);
  return { props, ...view };
}

async function renderReady(
  overrides: Partial<
    React.ComponentProps<typeof OneLocationOnboardingFlow>
  > = {},
) {
  const result = renderFlow({ activeScreen: "ready", ...overrides });
  await waitFor(() =>
    expect(
      screen.getByTestId("one-location-onboarding-invite-code"),
    ).toHaveTextContent("ABCD-EFGH-JKLM"),
  );
  return result;
}

describe("OneLocationOnboardingFlow introduction", () => {
  it("hides app chrome while mounted and starts at Features", () => {
    const { unmount } = renderFlow();
    expect(document.documentElement.hasAttribute("data-session-check-active")).toBe(true);
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    expect(screen.queryByLabelText("One Location setup progress")).toBeNull();
    expect(screen.queryByTestId("one-location-onboarding-welcome")).toBeNull();
    expect(screen.queryByText("Your location stays private until you share.")).toBeNull();
    expect(screen.queryByText("Location is ready. Your next tap opens the place picker.")).toBeNull();
    expect(screen.getByRole("button", { name: "Set up later" })).toBeEnabled();
    unmount();
    expect(document.documentElement.hasAttribute("data-session-check-active")).toBe(false);
  });

  it.each(["/one/location", "/one/setup/location"])("unwinds Ready to Features before exiting %s", async (routeId) => {
    const props = createProps({ nativeTest: { ...createProps().nativeTest, routeId } });
    function ControlledFlow() {
      const [activeScreen, setScreen] = useState<"features" | "ready">("features");
      return <OneLocationOnboardingFlow {...props} activeScreen={activeScreen} onScreenChange={setScreen} />;
    }
    const { unmount } = render(<ControlledFlow />);
    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
    expect(screen.getByTestId("one-location-onboarding-ready")).toBeTruthy();
    expect(screen.queryByLabelText("One Location setup progress")).toBeNull();
    act(() => { expect(unwindBackLayer(routeId)).toBe(true); });
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    expect(props.onBack).not.toHaveBeenCalled();
    act(() => { expect(unwindBackLayer(routeId)).toBe(true); });
    expect(props.onBack).toHaveBeenCalledTimes(1);
    unmount();
    expect(unwindBackLayer(routeId)).toBe(false);
  });

  describe("optional location access without a third screen", () => {
    function ControlledFlow(
      props: React.ComponentProps<typeof OneLocationOnboardingFlow>,
    ) {
      const [activeScreen, setScreen] = useState<
        "features" | "ready"
      >("features");
      return (
        <OneLocationOnboardingFlow
          {...props}
          activeScreen={activeScreen}
          onScreenChange={setScreen}
        />
      );
    }

    it.each([true, false, "rejects"] as const)(
      "requests location only on a tap and keeps the place editable (%s)",
      async (outcome) => {
        const onPrepareLocation =
          outcome === "rejects"
            ? vi.fn().mockRejectedValue(new Error("denied"))
            : vi.fn().mockResolvedValue(outcome);
        render(<ControlledFlow {...createProps({ onPrepareLocation })} />);
        expect(onPrepareLocation).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Use my location" })).toBeEnabled());
        expect(screen.queryByTestId("one-location-onboarding-ready")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
        expect(screen.getByTestId("one-location-onboarding-ready")).toBeTruthy();
        expect(onPrepareLocation).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId("one-location-onboarding-place")).toBeNull();
      },
    );

    it("coalesces location acquisition and consumes Back while it settles", async () => {
      const routeId = "/one/location";
      let resolveLocation!: (ready: boolean) => void;
      const onPrepareLocation = vi.fn(() => new Promise<boolean>((resolve) => {
        resolveLocation = resolve;
      }));
      render(
        <ControlledFlow
          {...createProps({ onPrepareLocation })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
      expect(screen.getByRole("button", { name: /Finding location/ })).toBeDisabled();
      expect(onPrepareLocation).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Set up later" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
      act(() => {
        expect(unwindBackLayer(routeId)).toBe(true);
      });
      expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
      await act(async () => resolveLocation(true));
      expect(screen.queryByTestId("one-location-onboarding-ready")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
      expect(screen.getByTestId("one-location-onboarding-ready")).toBeTruthy();
    });
  });

  it("defers the place without skipping the capability or leaving onboarding", () => {
    const { props } = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
    expect(props.onSkip).not.toHaveBeenCalled();
    expect(screen.getByTestId("one-location-onboarding-ready")).toBeTruthy();
    expect(props.onBack).not.toHaveBeenCalled();
  });

  it.each(["welcome", "permissions"] as const)("maps legacy %s entries to Features", (startAt) => {
    renderFlow({ startAt });
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    expect(screen.queryByLabelText("One Location setup progress")).toBeNull();
  });
});

describe("OneLocationOnboardingFlow combined Ready screen", () => {
  it("shows invite, Join, Contacts, and Finish together without auto-opening optional work", async () => {
    const onSyncOnboardingContacts = vi.fn();
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts,
    });

    expect(screen.getByText("Your circle code")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Join with a code" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Find contacts" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Open One Location" }),
    ).toBeEnabled();
    expect(onSyncOnboardingContacts).not.toHaveBeenCalled();
  });

  it("uses an evergreen heading while sharing the original circle invite", async () => {
    const invite = { ...INVITE, circleName: "Diwali Special" };
    const { props } = await renderReady({
      onPrepareOnboardingCircleInvite: vi.fn().mockResolvedValue(invite),
    });
    expect(screen.getByText("Your circle code")).toBeTruthy();
    expect(screen.queryByText("Diwali Special")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(props.onShareOnboardingCircleCode).toHaveBeenCalledWith(invite);
  });

  it("keeps only one optional disclosure open", async () => {
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Join with a code" }));
    expect(screen.getByLabelText("Circle code")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));

    expect(screen.queryByLabelText("Circle code")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Check my contacts" }),
    ).toBeTruthy();
  });

  it("keeps Find contacts concise with an explicit contact-check action", async () => {
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));

    expect(screen.queryByText(/Phone numbers are standardized/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check my contacts" })).toBeEnabled();
  });

  it("syncs contacts only after Check my contacts and sends a selected request", async () => {
    const onSyncOnboardingContacts = vi.fn().mockResolvedValue({
      status: "matched",
      matches: [
        {
          userId: "friend-1",
          displayName: "Aarav Sharma",
          connectionStatus: "request_required",
        },
      ],
    });
    const onAddOnboardingContact = vi.fn().mockResolvedValue(undefined);
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts,
      onAddOnboardingContact,
    });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    expect(onSyncOnboardingContacts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

    expect(await screen.findByText("Aarav Sharma")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Request" }));
    await waitFor(() =>
      expect(onAddOnboardingContact).toHaveBeenCalledWith("friend-1"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.getByRole("button", { name: "Open One Location" }),
    ).toBeEnabled();
  });

  it("explains a complete contact check with no eligible matches", async () => {
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts: vi.fn().mockResolvedValue({
        status: "none",
        partial: false,
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

    expect(
      await screen.findByText("No eligible contacts matched."),
    ).toBeTruthy();
    expect(
      screen.getByText(/exact verified phone match connect automatically/),
    ).toBeTruthy();
    expect(screen.getByText(/circle code above/)).toBeTruthy();
  });

  it("offers the Google account chooser after an empty Google read", async () => {
    // A silent retry re-reads the same (possibly empty) Google account, so
    // an empty read must offer the chooser instead of looping on "none".
    const onSyncOnboardingContacts = vi.fn().mockResolvedValue({
      status: "none",
      partial: false,
    });
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts,
      showGoogleAccountSwitcher: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

    const switcher = await screen.findByRole("button", {
      name: "Check a different Google account",
    });
    fireEvent.click(switcher);
    await waitFor(() =>
      expect(onSyncOnboardingContacts).toHaveBeenLastCalledWith({
        chooseGoogleAccount: true,
      }),
    );
    // The silent retry stays available beside it.
    expect(
      screen.getByRole("button", { name: "Sync again" }),
    ).toBeTruthy();
  });

  it("hides the account switcher without the flag", async () => {
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts: vi.fn().mockResolvedValue({
        status: "none",
        partial: false,
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

    expect(
      await screen.findByText("No eligible contacts matched."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Check a different Google account",
      }),
    ).toBeNull();
  });

  it("requests another account through the sync handler and keeps results on dismiss", async () => {
    const onSyncOnboardingContacts = vi
      .fn()
      .mockResolvedValueOnce({ status: "none", partial: false })
      .mockResolvedValueOnce({ status: "cancelled" });
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts,
      showGoogleAccountSwitcher: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

    expect(
      await screen.findByText("No eligible contacts matched."),
    ).toBeTruthy();
    expect(onSyncOnboardingContacts).toHaveBeenCalledTimes(1);
    expect(onSyncOnboardingContacts).toHaveBeenNthCalledWith(1, undefined);

    // The switcher run goes through the same internal handler with the flag.
    fireEvent.click(
      screen.getByRole("button", { name: "Check a different Google account" }),
    );
    await waitFor(() =>
      expect(onSyncOnboardingContacts).toHaveBeenNthCalledWith(2, {
        chooseGoogleAccount: true,
      }),
    );
    // Dismissing the chooser is not a reset: the empty state stays instead
    // of dropping back to the primed card.
    expect(
      await screen.findByText("No eligible contacts matched."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Check my contacts" }),
    ).toBeNull();
  });

  it("does not present a partial contact check as the whole directory", async () => {
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts: vi.fn().mockResolvedValue({
        status: "none",
        partial: true,
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

    expect(
      await screen.findByText("No eligible contacts matched."),
    ).toBeTruthy();
    expect(
      screen.getByText(/Only part of your contact list was checked/),
    ).toBeTruthy();
  });

  it("preserves every connection outcome and partial warning when retrying", async () => {
    const summary =
      "2 contacts need confirmation and are not counted as unmatched or inviteable.";
    const onSyncOnboardingContacts = vi.fn().mockResolvedValue({
      status: "matched",
      partial: true,
      summary,
      matches: [
        {
          userId: "new",
          displayName: "Asha Rao",
          connectionStatus: "auto_connected",
        },
        {
          userId: "existing",
          displayName: "Meena Shah",
          connectionStatus: "already_connected",
        },
        {
          userId: "removed",
          displayName: "Ravi Kumar",
          connectionStatus: "suppressed",
        },
      ],
    });
    const onAddOnboardingContact = vi.fn();
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts,
      onAddOnboardingContact,
    });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

    expect(await screen.findByText(summary)).toBeInTheDocument();
    for (const [name, status] of [
      ["Asha Rao", "Connected now"],
      ["Meena Shah", "Already connected"],
      ["Ravi Kumar", "Kept disconnected"],
    ]) {
      expect(
        within(screen.getByText(name).closest("li")!).getByText(status),
      ).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Request" })).toBeNull();
    expect(onAddOnboardingContact).not.toHaveBeenCalled();
    onSyncOnboardingContacts.mockResolvedValueOnce({
      status: "none",
      partial: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Sync again" }));
    expect(
      await screen.findByText("No eligible contacts matched."),
    ).toBeInTheDocument();
    expect(screen.queryByText(summary)).toBeNull();
    expect(onSyncOnboardingContacts).toHaveBeenCalledTimes(2);
  });

  it("retries a device failure that does not require Settings", async () => {
    const onSyncOnboardingContacts = vi
      .fn()
      .mockResolvedValueOnce({
        status: "failed",
        message: "Try the contact check again.",
        canOpenSettings: false,
      })
      .mockResolvedValueOnce({ status: "none", partial: false });
    await renderReady({ contactsSource: "device", onSyncOnboardingContacts });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("No eligible contacts matched."),
    ).toBeInTheDocument();
    expect(onSyncOnboardingContacts).toHaveBeenCalledTimes(2);
  });

  it("updates the inline results when Settings resumes the contact check", async () => {
    const onOpenContactSettings = vi.fn();
    const onSyncOnboardingContacts = vi
      .fn()
      .mockResolvedValueOnce({
        status: "failed",
        message: "Contacts access is off.",
        canOpenSettings: true,
      })
      .mockResolvedValueOnce({
        status: "matched",
        matches: [
          {
            userId: "new",
            displayName: "Asha Rao",
            connectionStatus: "auto_connected",
          },
        ],
      });
    await renderReady({ onSyncOnboardingContacts, onOpenContactSettings });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));

    await act(async () => onOpenContactSettings.mock.calls[0][0]());
    expect(await screen.findByText("Asha Rao")).toBeInTheDocument();
    expect(screen.getByText("Connected now")).toBeInTheDocument();
    expect(screen.queryByText("Contacts access is off.")).toBeNull();
    expect(onSyncOnboardingContacts).toHaveBeenCalledTimes(2);
  });

  it("shows contact denial recovery without blocking Finish", async () => {
    const onOpenContactSettings = vi.fn();
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts: vi.fn().mockResolvedValue({
        status: "failed",
        message: "Contacts access is off.",
        canOpenSettings: true,
      }),
      onOpenContactSettings,
    });
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

    expect(await screen.findByText("Contacts access is off.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenContactSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.getByRole("button", { name: "Open One Location" }),
    ).toBeEnabled();
  });

  it("previews and accepts a Circle code", async () => {
    const onAcceptCircleCode = vi.fn().mockResolvedValue(undefined);
    await renderReady({ onAcceptCircleCode });
    fireEvent.click(screen.getByRole("button", { name: "Join with a code" }));
    fireEvent.change(screen.getByLabelText("Circle code"), {
      target: { value: "ZXCVBNMASDFG" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));

    expect(await screen.findByText("Family")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join Family" }));
    await waitFor(() =>
      expect(onAcceptCircleCode).toHaveBeenCalledWith("ZXCVBNMASDFG"),
    );
    expect(
      await screen.findByText(/You'll join Family after setup/),
    ).toBeTruthy();
  });

  it("rejects the owner's own invite code without a lookup", async () => {
    const onPreviewCircleCode = vi.fn();
    await renderReady({ onPreviewCircleCode });
    fireEvent.click(screen.getByRole("button", { name: "Join with a code" }));
    fireEvent.change(screen.getByLabelText("Circle code"), {
      target: { value: "ABCD-EFGH-JKLM" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("your own code");
    expect(onPreviewCircleCode).not.toHaveBeenCalled();
  });

  it("copies and shares the invite code", async () => {
    const { props } = await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(props.onCopyOnboardingCircleCode).toHaveBeenCalledWith(INVITE.code);
    expect(props.onShareOnboardingCircleCode).toHaveBeenCalledWith(INVITE);
  });

  it("keeps Finish available when invite provisioning fails", async () => {
    renderFlow({
      activeScreen: "ready",
      onPrepareOnboardingCircleInvite: vi
        .fn()
        .mockRejectedValue(new Error("offline")),
    });

    expect(
      await screen.findByRole("button", { name: "Try again" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open One Location" }),
    ).toBeEnabled();
  });

  it("completes only after the terminal CTA is pressed", async () => {
    const { props } = await renderReady();
    expect(props.onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open One Location" }));
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });

  it("returns from Ready to Features", async () => {
    const onScreenChange = vi.fn();
    await renderReady({ onScreenChange });
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(onScreenChange).toHaveBeenLastCalledWith("features");
  });

  it("keeps the map claim honest", async () => {
    await renderReady({ mapPoint: null });
    expect(
      screen.getByRole("heading", { name: "Your people." }),
    ).toBeTruthy();
    expect(screen.getByText("Turn on Location when you're ready.")).toBeTruthy();
  });
});
