import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OneLocationOnboardingFlow } from "@/components/one-location/onboarding/one-location-onboarding-flow";

const INVITE = {
  circleId: "circle-1",
  circleName: "Meena Family",
  code: "ABCDEFGHJKLM",
};

const grantedPermission = {
  state: "granted" as const,
  precise: true,
  background: "foreground-only" as const,
  locationServicesEnabled: true,
};

function createProps(
  overrides: Partial<
    React.ComponentProps<typeof OneLocationOnboardingFlow>
  > = {},
): React.ComponentProps<typeof OneLocationOnboardingFlow> {
  return {
    startAt: "welcome",
    currentUserName: "Test User",
    locationPermission: {
      state: "prompt",
      precise: null,
      background: "foreground-only",
      locationServicesEnabled: true,
    },
    locationBusy: false,
    nativeTest: {
      routeId: "/one/location",
      marker: "native-route-one-location",
      authState: "authenticated",
      dataState: "loaded",
    },
    onRequestLocation: vi.fn().mockResolvedValue(true),
    onLocationReady: vi.fn().mockResolvedValue(true),
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

describe("OneLocationOnboardingFlow four-step contract", () => {
  it("keeps the authored blue welcome and exposes step 1 of 4", () => {
    renderFlow();

    expect(screen.getByTestId("one-location-onboarding-welcome")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Share your location easily with anyone.",
      }),
    ).toBeTruthy();
    expect(screen.getByText("1 of 4")).toBeTruthy();
    expect(screen.getByTestId("location-agent-heading-icon")).toBeTruthy();
  });

  it("keeps Back and Skip separate on Welcome", () => {
    const { props } = renderFlow();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(props.onSkip).not.toHaveBeenCalled();
  });

  it("moves Get started only to Features and triggers no permission or capture", () => {
    const { props } = renderFlow();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    expect(screen.getByText("2 of 4")).toBeTruthy();
    expect(props.onRequestLocation).not.toHaveBeenCalled();
    expect(props.onLocationReady).not.toHaveBeenCalled();
  });

  it("retains the two approved intro screens and exact feature CTA", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(
      screen.getByRole("heading", { name: "Keep your people updated." }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Can’t explain where you are?" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Stuck waiting in line?" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Need help but can’t talk?" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Set up my location" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Your location stays private until you share."),
    ).toBeTruthy();
  });

  it("requests Location only after the explicit Features CTA and advances to place", async () => {
    const onScreenChange = vi.fn();
    const { props } = renderFlow({ onScreenChange });
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up my location" }));

    await waitFor(() =>
      expect(props.onRequestLocation).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(props.onLocationReady).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onScreenChange).toHaveBeenLastCalledWith("place"),
    );
    expect(screen.getByTestId("one-location-onboarding-place")).toBeTruthy();
  });

  it("uses an already-granted Location without another permission request", async () => {
    const { props } = renderFlow({ locationPermission: grantedPermission });
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up my location" }));

    await waitFor(() => expect(props.onLocationReady).toHaveBeenCalledTimes(1));
    expect(props.onRequestLocation).not.toHaveBeenCalled();
  });

  it("stays on Features when Location is declined", async () => {
    const onRequestLocation = vi.fn().mockResolvedValue(false);
    renderFlow({
      onRequestLocation,
      locationPermission: {
        state: "denied",
        precise: null,
        background: "foreground-only",
        locationServicesEnabled: true,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(
      screen.getByText(
        "Location access is off. Turn it on to set up One Location.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await waitFor(() => expect(onRequestLocation).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
  });

  it("stays retryable when coordinate capture fails", async () => {
    renderFlow({
      locationPermission: grantedPermission,
      onLocationReady: vi.fn().mockResolvedValue(false),
    });
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up my location" }));

    expect(
      await screen.findByRole("button", { name: "Try again" }),
    ).toBeTruthy();
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
  });

  it("does not auto-request permission for the legacy permissions entry", () => {
    const { props } = renderFlow({ startAt: "permissions" });

    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    expect(props.onRequestLocation).not.toHaveBeenCalled();
    expect(props.onLocationReady).not.toHaveBeenCalled();
  });

  it.each([
    ["welcome", "one-location-onboarding-welcome", "1 of 4"],
    ["features", "one-location-onboarding-features", "2 of 4"],
    ["place", "one-location-onboarding-place", null],
    ["ready", "one-location-onboarding-ready", "4 of 4"],
  ] as const)(
    "renders the controlled %s checkpoint",
    (activeScreen, testId, progress) => {
      renderFlow({ activeScreen });
      expect(screen.getByTestId(testId)).toBeTruthy();
      if (progress) expect(screen.getByText(progress)).toBeTruthy();
    },
  );
});

describe("OneLocationOnboardingFlow combined Ready screen", () => {
  it("shows invite, Join, Contacts, and Finish together without auto-opening optional work", async () => {
    const onSyncOnboardingContacts = vi.fn();
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts,
    });

    expect(screen.getByText("Meena Family")).toBeTruthy();
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

  it("keeps only one optional disclosure open", async () => {
    await renderReady({
      contactsStepAvailable: true,
      onSyncOnboardingContacts: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Join with a code" }));
    expect(screen.getByLabelText("Circle code")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));

    expect(screen.queryByLabelText("Circle code")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Check my contacts" }),
    ).toBeTruthy();
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
    expect(
      screen.getByRole("button", { name: "Open One Location" }),
    ).toBeEnabled();
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

  it("returns from Ready to the saved-place checkpoint", async () => {
    const onScreenChange = vi.fn();
    await renderReady({ onScreenChange });
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(onScreenChange).toHaveBeenLastCalledWith("place");
  });

  it("keeps the map claim honest", async () => {
    await renderReady({ mapPoint: null });
    expect(
      screen.getByRole("heading", { name: "You're all set." }),
    ).toBeTruthy();
    expect(screen.getByText("Map unavailable")).toBeTruthy();
  });
});
