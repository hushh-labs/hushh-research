import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  overrides: Partial<
    React.ComponentProps<typeof OneLocationOnboardingFlow>
  > = {},
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
    onSkip: vi.fn(),
    ...overrides,
  };

  render(<OneLocationOnboardingFlow {...props} />);
  return props;
}

function openPeopleScreen() {
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OneLocationOnboardingFlow", () => {
  it("renders the new welcome screen and lets the user leave safely", () => {
    const props = renderFlow();

    expect(screen.getByTestId("one-location-onboarding-welcome")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "The people you love. Always in reach.",
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("location-agent-heading-icon")).toBeTruthy();
    const welcomeAvatar = document.querySelector(
      'img[src="/one-location/onboarding/akshat.webp"]',
    );
    expect(welcomeAvatar?.parentElement?.className).toContain("rounded-[13px]");
    expect(welcomeAvatar?.parentElement?.className).not.toContain(
      "rounded-full",
    );

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(props.onSkip).toHaveBeenCalledTimes(1);
  });

  it("replaces the old feature carousel with one supplied-art use-case screen", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "When it matters, your people know.",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Need help fast?")).toBeTruthy();
    expect(screen.getByText("Meeting a friend?")).toBeTruthy();
    expect(screen.getByText("Riding home late?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(
      screen
        .getByTestId("location-use-case-sos")
        .querySelector('img[src="/one-location/onboarding/il-shield.png"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByTestId("location-use-case-checkin")
        .querySelector('img[src="/one-location/onboarding/il-pin.png"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByTestId("location-use-case-trip")
        .querySelector('img[src="/one-location/onboarding/il-car.png"]'),
    ).toBeTruthy();
    expect(screen.queryByText("Connected Person")).toBeNull();
  });

  it("requests only missing permissions as screen two opens", () => {
    const props = renderFlow();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    expect(props.onRequestNotifications).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    expect(props.onRequestNotifications).toHaveBeenCalledTimes(1);
  });

  it("does not re-request permissions that are already ready", () => {
    const props = renderFlow({
      locationPermission: {
        state: "granted",
        precise: true,
        background: "foreground-only",
        locationServicesEnabled: true,
      },
      notificationDeliveryMode: "push_active",
    });

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(props.onRequestLocation).not.toHaveBeenCalled();
    expect(props.onRequestNotifications).not.toHaveBeenCalled();
  });

  it("keeps setup on screen two until required Location access is ready", () => {
    const props = renderFlow({ requireLocationToComplete: true });

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("button", { name: "Allow location" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow location" }));

    expect(props.onRequestLocation).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    expect(screen.queryByTestId("one-location-onboarding-people")).toBeNull();
  });

  it("supports the previous permissions-only entry through the consolidated screen", async () => {
    const props = renderFlow({ startAt: "permissions" });

    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    await waitFor(() => {
      expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
      expect(props.onRequestNotifications).toHaveBeenCalledTimes(1);
    });
  });

  it("requires at least one selected contact before Continue is enabled", () => {
    renderFlow({
      people: [people[1]!],
      connections: [],
    });
    openPeopleScreen();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();
    expect(
      screen.getByText("Select at least one person to continue"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add New Person" }));
    expect(continueButton).not.toBeDisabled();
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("sends deliberate requests, shows selected people, and auto-completes after four seconds", async () => {
    vi.useFakeTimers();
    const props = renderFlow();
    openPeopleScreen();

    fireEvent.click(screen.getByRole("button", { name: "Add New Person" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(props.onSendConnectionRequests).toHaveBeenCalledWith(["new_user"]);
    expect(screen.getByTestId("one-location-onboarding-circle")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Your circle, your choice" }),
    ).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999);
    });
    expect(props.onComplete).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });

  it("automatically retries a transient durable-settlement failure without adding a completion button", async () => {
    vi.useFakeTimers();
    const onComplete = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(undefined);
    renderFlow({ onComplete });
    openPeopleScreen();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("retains contact selection and cancels completion when Back leaves the final circle", async () => {
    vi.useFakeTimers();
    const props = renderFlow();
    openPeopleScreen();

    fireEvent.click(screen.getByRole("button", { name: "Add New Person" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove New Person" }),
    ).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(props.onComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("one-location-onboarding-welcome")).toBeTruthy();
  });

  it("keeps explicit dark surfaces on every onboarding screen", () => {
    renderFlow();
    const welcome = screen.getByTestId("one-location-onboarding-welcome");
    expect(welcome.firstElementChild?.className).toContain("dark:bg-[#071d39]");

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    const features = screen.getByTestId("one-location-onboarding-features");
    expect(features.firstElementChild?.className).toContain(
      "dark:bg-[#0c1017]",
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const peopleScreen = screen.getByTestId("one-location-onboarding-people");
    expect(peopleScreen.firstElementChild?.className).toContain(
      "dark:bg-[#14171d]",
    );

    fireEvent.click(screen.getByRole("button", { name: "Add New Person" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const circle = screen.getByTestId("one-location-onboarding-circle");
    expect(circle.firstElementChild?.className).toContain("dark:bg-[#0c1017]");
  });

  it("keeps Continue disabled while recommended contacts are loading", () => {
    renderFlow({ people: [], connections: [], peopleLoading: true });
    openPeopleScreen();

    expect(screen.getByText("Finding your people")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});
