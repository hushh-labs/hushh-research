import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OneLocationOnboardingFlow } from "@/components/one-location/onboarding/one-location-onboarding-flow";

const people = [
  {
    userId: "connected_user",
    displayName: "Connected Person",
    photoUrl: null,
    email: "connected@example.com",
    relationship: "connected" as const,
  },
  {
    userId: "new_user",
    displayName: "New Person",
    photoUrl: null,
    email: "new@example.com",
    relationship: "none" as const,
  },
];

const connections = [
  {
    connectionId: "connection_1",
    userId: "connected_user",
    displayName: "Connected Person",
    photoUrl: null,
    createdAt: "2026-07-13T08:00:00.000Z",
  },
];

function renderFlow(
  overrides: Partial<React.ComponentProps<typeof OneLocationOnboardingFlow>> = {},
) {
  const props: React.ComponentProps<typeof OneLocationOnboardingFlow> = {
    startAt: "welcome",
    currentUserName: "Test User",
    currentUserPhotoUrl: null,
    people,
    connections,
    peopleLoading: false,
    peopleError: null,
    locationPermission: {
      state: "prompt",
      precise: null,
      background: "foreground-only",
      locationServicesEnabled: true,
    },
    notificationDeliveryMode: "inbox_only",
    notificationBusy: false,
    locationBusy: false,
    nativeTest: {
      routeId: "/one/location",
      marker: "native-route-one-location",
      authState: "authenticated",
      dataState: "loaded",
    },
    onRetryPeople: vi.fn(),
    onSendConnectionRequests: vi.fn().mockResolvedValue({
      sentUserIds: ["new_user"],
      failedUserIds: [],
    }),
    onRequestLocation: vi.fn().mockResolvedValue(undefined),
    onRequestNotifications: vi.fn().mockResolvedValue(undefined),
    onComplete: vi.fn(),
    ...overrides,
  };

  render(<OneLocationOnboardingFlow {...props} />);
  return props;
}

describe("OneLocationOnboardingFlow", () => {
  it("runs the complete introduction and sends only deliberate connection requests", async () => {
    const props = renderFlow();

    expect(
      screen.getByRole("heading", {
        name: "The people you love. Always in reach.",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "Know when they arrive" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Let them know you're here" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Help when it matters most" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create my circle" }));
    expect(screen.getByRole("heading", { name: "Add people" })).toBeTruthy();
    expect(screen.queryByText(/Share invite link/i)).toBeNull();

    // Existing connections are selected by default. A new person is selected
    // only after an explicit user action, and only that person gets a request.
    expect(
      screen.getByRole("button", { name: /Remove Connected Person/i }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Add New Person/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(props.onSendConnectionRequests).toHaveBeenCalledWith(["new_user"]),
    );
    expect(
      await screen.findByRole("heading", { name: "Your circle is taking shape" }),
    ).toBeTruthy();
    expect(screen.getByText("1 connection request sent.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "A few permissions. Nothing more." }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "Motion Activity permission" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Location permission" }));
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("switch", { name: "Notifications permission" }));
    expect(props.onRequestNotifications).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });

  it("supports an explicit permissions-only entry", async () => {
    const onRequestLocation = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn();
    renderFlow({
      startAt: "permissions",
      locationPermission: {
        state: "denied",
        precise: false,
        background: "restricted",
        locationServicesEnabled: true,
      },
      onRequestLocation,
      onComplete,
    });

    expect(
      screen.getByRole("heading", { name: "A few permissions. Nothing more." }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    // The test environment reports the web platform, so the blocked-permission
    // copy is the browser-specific variant (native uses "Open device Settings").
    expect(
      screen.getByText(/Allow it from your browser's site permissions/i),
    ).toBeTruthy();


    fireEvent.click(screen.getByRole("switch", { name: "Location permission" }));
    expect(onRequestLocation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("continues while recommended contacts are still loading", () => {
    const props = renderFlow({
      people: [],
      connections: [],
      peopleLoading: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("heading", { name: "Add people" })).toBeTruthy();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).not.toBeDisabled();
    fireEvent.click(continueButton);

    expect(
      screen.getByRole("heading", { name: "Your circle, your choice" }),
    ).toBeTruthy();
    expect(props.onSendConnectionRequests).not.toHaveBeenCalled();
  });

  it("moves to the circle without waiting for connection requests", async () => {
    let resolveRequests: (result: {
      sentUserIds: string[];
      failedUserIds: string[];
    }) => void = () => undefined;
    const onSendConnectionRequests = vi.fn(
      () =>
        new Promise<{ sentUserIds: string[]; failedUserIds: string[] }>(
          (resolve) => {
            resolveRequests = resolve;
          },
        ),
    );
    renderFlow({ onSendConnectionRequests });

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: /Add New Person/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByRole("heading", { name: "Your circle is taking shape" }),
    ).toBeTruthy();
    expect(screen.getByText("Sending 1 connection request...")).toBeTruthy();

    resolveRequests({ sentUserIds: ["new_user"], failedUserIds: [] });
    expect(await screen.findByText("1 connection request sent.")).toBeTruthy();
  });

  it("keeps granted permission controls actionable", () => {
    const onRequestLocation = vi.fn().mockResolvedValue(undefined);
    const onRequestNotifications = vi.fn().mockResolvedValue(undefined);
    renderFlow({
      startAt: "permissions",
      locationPermission: {
        state: "granted",
        precise: true,
        background: "foreground-only",
        locationServicesEnabled: true,
      },
      notificationDeliveryMode: "push_active",
      onRequestLocation,
      onRequestNotifications,
    });

    const locationSwitch = screen.getByRole("switch", {
      name: "Location permission",
    });
    const notificationSwitch = screen.getByRole("switch", {
      name: "Notifications permission",
    });
    expect(locationSwitch).not.toBeDisabled();
    expect(notificationSwitch).not.toBeDisabled();

    fireEvent.click(locationSwitch);
    fireEvent.click(notificationSwitch);
    expect(onRequestLocation).toHaveBeenCalledTimes(1);
    expect(onRequestNotifications).toHaveBeenCalledTimes(1);
  });
});
