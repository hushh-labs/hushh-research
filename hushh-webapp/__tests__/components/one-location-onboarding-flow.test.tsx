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
    onLocationReady: vi.fn().mockResolvedValue(true),
    onRequestNotifications: vi.fn().mockResolvedValue(undefined),
    onBack: vi.fn(),
    onComplete: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };

  const view = render(<OneLocationOnboardingFlow {...props} />);
  return {
    ...props,
    rerenderFlow: (
      nextOverrides: Partial<
        React.ComponentProps<typeof OneLocationOnboardingFlow>
      >,
    ) => {
      Object.assign(props, nextOverrides);
      view.rerender(<OneLocationOnboardingFlow {...props} />);
    },
  };
}

function openPeopleScreen() {
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OneLocationOnboardingFlow", () => {
  it("keeps first-screen Back separate from Skip", () => {
    const props = renderFlow();

    expect(screen.getByTestId("one-location-onboarding-welcome")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Share your location easily with anyone.",
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("location-agent-heading-icon")).toBeTruthy();
    const welcomeAvatar = document.querySelector(
      'img[src="/one-location/onboarding/orbit-person-1.webp"]',
    );
    expect(welcomeAvatar?.parentElement?.className).toContain("rounded-[18px]");
    expect(welcomeAvatar?.parentElement?.className).not.toContain(
      "rounded-full",
    );
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(props.onSkip).not.toHaveBeenCalled();
  });

  it("fits the supplied-art use cases into one non-scrolling screen", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    const featureSurface = screen.getByTestId(
      "one-location-onboarding-features",
    ).firstElementChild;
    expect(featureSurface?.className).toContain("overflow-hidden");
    expect(featureSurface?.className).toContain("flex-col");
    expect(featureSurface?.className).toContain("bg-[#f5f5f7]");
    expect(featureSurface?.className).toContain("pl-6");
    expect(featureSurface?.className).toContain("pr-5");
    expect(featureSurface?.className).toContain(
      "pt-[max(env(safe-area-inset-top,0px),55px)]",
    );
    expect(
      document.querySelector("[data-one-feature-grid]")?.className,
    ).toContain("grid-rows-3");
    expect(
      document.querySelector("[data-one-feature-grid]")?.className,
    ).toContain("mt-[18px]");
    expect(
      document.querySelector("[data-one-feature-cta] button")?.className,
    ).toContain("h-[52px]");
    for (const card of document.querySelectorAll("[data-one-use-case-card]")) {
      expect(card.className).toContain("h-full");
      expect(card.className).toContain("min-h-0");
      expect(
        card.querySelector("[data-one-use-case-alert]")?.className,
      ).toContain("w-max");
      expect(
        card.querySelector("[data-one-use-case-alert] span.whitespace-nowrap")
          ?.className,
      ).toContain("min-w-max");
      expect(
        card.querySelector("[data-one-use-case-alert] .truncate"),
      ).toBeNull();
    }
    expect(
      screen.getByRole("heading", {
        name: "Stay connected when you need it.",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Need help, but can’t call or speak?",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Still answering “Where are you?”",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Meeting up, but can’t find each other?",
      }),
    ).toBeTruthy();
    expect(screen.getByText("SMS · Save My Soul")).toBeTruthy();
    expect(screen.getByText("Shared securely")).toBeTruthy();
    expect(screen.getByText("Check-in sent")).toBeTruthy();

    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(
      screen
        .getByTestId("location-use-case-checkin")
        .querySelector(
          'img[src="/one-location/onboarding/feature-checkin-pin-transparent.webp"]',
        ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(screen.queryByText("Connected Person")).toBeNull();
  });

  it("requests only missing permissions as screen two opens", () => {
    const props = renderFlow();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    expect(props.onLocationReady).not.toHaveBeenCalled();
    expect(props.onRequestNotifications).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    expect(props.onRequestNotifications).toHaveBeenCalledTimes(1);
  });

  it("runs Location-ready onboarding work without re-requesting permission", async () => {
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
    await waitFor(() =>
      expect(props.onLocationReady).toHaveBeenCalledTimes(1),
    );
    expect(props.onRequestNotifications).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(props.onLocationReady).toHaveBeenCalledTimes(1);
  });

  it("prepares the saved-place step after the user returns from device Settings", async () => {
    const props = renderFlow({
      locationPermission: {
        state: "denied",
        precise: false,
        background: "restricted",
        locationServicesEnabled: true,
      },
      notificationDeliveryMode: "push_active",
    });

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    expect(props.onLocationReady).not.toHaveBeenCalled();

    props.rerenderFlow({
      locationPermission: {
        state: "granted",
        precise: true,
        background: "foreground-only",
        locationServicesEnabled: true,
      },
    });

    await waitFor(() =>
      expect(props.onLocationReady).toHaveBeenCalledTimes(1),
    );
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
  });

  it("blocks advancement while the saved-place step is preparing", async () => {
    let resolvePreparation: ((complete: boolean) => void) | null = null;
    const onLocationReady = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    renderFlow({
      locationPermission: {
        state: "granted",
        precise: true,
        background: "foreground-only",
        locationServicesEnabled: true,
      },
      notificationDeliveryMode: "push_active",
      onLocationReady,
    });

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    await waitFor(() => expect(onLocationReady).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.queryByTestId("one-location-onboarding-people")).toBeNull();

    await act(async () => {
      resolvePreparation?.(true);
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
  });

  it("keeps setup on screen two until required Location access is ready", () => {
    const props = renderFlow({ requireLocationToComplete: true });

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

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

  it("lets the user continue without selecting anyone and sends no requests", () => {
    const props = renderFlow({
      people: [people[1]!],
      connections: [],
    });
    openPeopleScreen();

    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeEnabled();
    expect(
      screen.getByText("Add anyone you'd like — or just continue"),
    ).toBeTruthy();

    fireEvent.click(continueButton);
    expect(props.onSendConnectionRequests).not.toHaveBeenCalled();
    expect(screen.getByTestId("one-location-onboarding-circle")).toBeTruthy();
  });

  it("keeps Continue enabled and counts people as they are selected", () => {
    renderFlow({
      people: [people[1]!],
      connections: [],
    });
    openPeopleScreen();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Add New Person" }));
    expect(continueButton).toBeEnabled();
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("advances the optional people step on Skip without ending onboarding", () => {
    const props = renderFlow({
      people: [people[1]!],
      connections: [],
    });
    openPeopleScreen();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(screen.getByTestId("one-location-onboarding-circle")).toBeTruthy();
    expect(props.onSkip).not.toHaveBeenCalled();
    expect(props.onComplete).not.toHaveBeenCalled();
    expect(props.onSendConnectionRequests).not.toHaveBeenCalled();
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
      screen.getByRole("heading", { name: "Your circle is ready." }),
    ).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.getByText("Joined")).toBeTruthy();
    expect(screen.getByText("Invited")).toBeTruthy();
    expect(screen.getByText("Add more")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();

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
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("offers Skip before the final screen and removes all navigation from the final animation", () => {
    const props = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(props.onSkip).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });

  it("keeps explicit dark surfaces on every onboarding screen", () => {
    renderFlow();
    const welcome = screen.getByTestId("one-location-onboarding-welcome");
    expect(welcome.firstElementChild?.className).toContain("dark:bg-[#073d78]");

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

  it("lets the user refresh a genuinely empty recommendation list", () => {
    const props = renderFlow({
      people: [],
      connections: [],
      peopleLoading: false,
    });
    openPeopleScreen();

    fireEvent.click(screen.getByRole("button", { name: "Refresh people" }));

    expect(props.onRetryPeople).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});
