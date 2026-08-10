import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { OneLocationOnboardingFlow } from "@/components/one-location/onboarding/one-location-onboarding-flow";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

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
  fireEvent.click(screen.getByRole("button", { name: "Add my people" }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(toast.error).mockClear();
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
    const welcomeHotel = document.querySelector(
      'img[src="/one-location/onboarding/orbit-office.webp"]',
    );
    expect(welcomeHotel).toBeTruthy();
    expect(welcomeHotel?.className).toContain("object-contain");
    expect(welcomeHotel?.className).not.toContain("!w-auto");
    expect(welcomeHotel?.className).not.toContain("max-w-none");
    expect(welcomeHotel?.className).not.toContain("scale-[");
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(props.onSkip).not.toHaveBeenCalled();
  });

  it("keeps the mobile feature screen readable and fitted without page scrolling", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    const featureShell = screen.getByTestId("one-location-onboarding-features");
    expect(featureShell.className).toContain("max-w-[min(560px,58dvh)]");
    expect(featureShell.className).toContain("max-[431px]:max-w-none");
    const featureSurface = featureShell.firstElementChild;
    expect(featureSurface?.className).toContain("overflow-hidden");
    expect(featureSurface?.className).toContain("flex-col");
    expect(featureSurface?.className).toContain("bg-white");
    expect(featureSurface?.className).toContain("px-6");
    expect(featureSurface?.className).toContain(
      "pt-[max(var(--app-safe-area-top-effective,0px),12px)]",
    );

    const featureScroll = document.querySelector("[data-one-feature-scroll]");
    expect(featureScroll?.className).toContain("overflow-hidden");
    expect(featureScroll?.className).not.toContain("overflow-y-auto");
    expect(featureScroll?.className).toContain("flex-col");
    expect(featureScroll?.className).toContain("flex-[0_1_auto]");
    const featureGrid = document.querySelector("[data-one-feature-grid]");
    expect(featureGrid?.className).toContain("mt-6");
    expect(featureGrid?.className).toContain("shrink-0");
    const lowerGrid = document.querySelector("[data-one-feature-lower-grid]");
    expect(lowerGrid?.className).toContain("grid-cols-2");
    expect(
      document.querySelector("[data-one-feature-subtitle]")?.className,
    ).toContain("mt-4");
    const featureCta = document.querySelector("[data-one-feature-cta]");
    expect(featureCta?.className).not.toContain("mt-auto");
    expect(featureCta?.querySelector("button")?.className).toContain(
      "h-[58px]",
    );
    const responsiveStyles =
      featureSurface?.querySelector("style")?.textContent;
    expect(responsiveStyles).not.toContain(
      "var(--onboarding-agent-bar-clearance)",
    );
    expect(responsiveStyles).toContain(
      "grid-template-rows: minmax(0, 0.82fr) minmax(0, 1fr)",
    );
    expect(responsiveStyles).toContain("aspect-ratio: auto");
    expect(responsiveStyles).toContain(
      "font-size: clamp(14px, 9.5cqw, 15px)",
    );
    expect(responsiveStyles).toContain(
      "--foundation-title1-size: clamp(36px, 3vw, 40px)",
    );
    expect(responsiveStyles).toContain("--foundation-title1-size: 34px");
    expect(responsiveStyles).toContain("font-size: 13.5px");
    expect(responsiveStyles).toContain("margin-top: 8px");
    expect(responsiveStyles).toContain("margin-top: 6px");
    expect(responsiveStyles).toContain(
      "font-size: clamp(15px, calc(5vw - 4.5px), 17px)",
    );
    expect(responsiveStyles).toContain(
      "bottom: clamp(54px, calc(65vh - 486.6px), 120px)",
    );
    expect(responsiveStyles).toContain("align-items: flex-start");
    expect(responsiveStyles).toContain("--one-feature-copy-gap: 12px");
    expect(responsiveStyles).toContain("gap: var(--one-feature-copy-gap)");
    expect(responsiveStyles).toContain(
      "--one-feature-copy-gap: 8px",
    );
    expect(responsiveStyles).toContain(
      "--one-feature-copy-gap: 4px",
    );
    expect(responsiveStyles).toContain(
      "@media (max-width: 431px) and (max-height: 560px)",
    );
    expect(responsiveStyles).not.toContain("font-size: 7.5px");

    const cards = document.querySelectorAll("[data-one-use-case-card]");
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.className).toContain("aspect-");
      expect(card.className).toContain("w-full");
      expect(card.className).toContain("flex-col");
      expect(card.className).toContain("[container-type:inline-size]");
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
      expect(
        card.querySelector("[data-one-feature-status-row]")?.className,
      ).toContain("mt-auto");
      const titleLines = card.querySelectorAll("[data-one-feature-title-line]");
      expect(titleLines).toHaveLength(2);
      for (const line of titleLines) {
        expect(line.className).toContain("whitespace-nowrap");
      }
    }

    expect(
      Array.from(
        screen
          .getByTestId("location-use-case-trip")
          .querySelectorAll("[data-one-feature-title-line]"),
      ).map((line) => line.textContent),
    ).toEqual(["No more explaining", "where you are."]);
    expect(
      Array.from(
        screen
          .getByTestId("location-use-case-checkin")
          .querySelectorAll("[data-one-feature-title-line]"),
      ).map((line) => line.textContent),
    ).toEqual(["At the venue, but", "can\u2019t find each other?"]);
    expect(
      Array.from(
        screen
          .getByTestId("location-use-case-sos")
          .querySelectorAll("[data-one-feature-title-line]"),
      ).map((line) => line.textContent),
    ).toEqual(["Need help but can\u2019t", "call or speak?"]);

    expect(
      screen.getByRole("heading", { name: "Stay connected" }),
    ).toBeTruthy();
    expect(
      screen.getByText("For everyday plans, meetups, and emergencies."),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "No more explaining where you are.",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "At the venue, but can\u2019t find each other?",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Need help but can\u2019t call or speak?",
      }),
    ).toBeTruthy();

    expect(screen.getByText("Share location")).toBeTruthy();
    expect(screen.getByText("Check in")).toBeTruthy();
    expect(screen.getByText("SMS \u00b7 Save My Soul")).toBeTruthy();
    expect(screen.getByText("Sharing with Mom, Driver +1")).toBeTruthy();
    expect(screen.getByText("Checked in at Hotel Grand")).toBeTruthy();
    expect(screen.getByText("SMS sent to 3 contacts")).toBeTruthy();

    const smsCard = screen.getByTestId("location-use-case-sos");
    const smsCore = smsCard.querySelector("[data-one-sms-core]");
    const smsLabel = smsCard.querySelector("[data-one-sms-label]");
    const smsPulse = smsCard.querySelector("[data-one-sms-core-pulse]");
    const smsRadarRings = smsCard.querySelectorAll("[data-one-sms-radar-ring]");
    const smsArtRegion = smsCard.querySelector("[data-one-feature-art-region]");
    const smsRadarClearance = smsCard.querySelector(
      "[data-one-sms-radar-clearance]",
    );
    const smsRadar = smsCard.querySelector("[data-one-sms-radar]");
    expect(smsArtRegion?.className).toContain("flex-1");
    expect(smsRadarClearance?.className).toContain("h-[108px]");
    expect(smsRadarClearance?.className).toContain("w-[108px]");
    expect(smsRadar?.className).toContain("h-20");
    expect(smsRadar?.className).not.toContain("absolute");
    expect(smsCore?.className).not.toContain("animation:");
    expect(smsLabel?.className).not.toContain("animation:");
    expect(smsPulse?.className).toContain("animation:oneSmsCore");
    expect(smsRadarRings).toHaveLength(2);
    for (const ring of smsRadarRings) {
      expect(ring.className).toContain("animation:oneSmsRadar");
    }

    expect(screen.getByTestId("location-use-case-trip").className).toContain(
      "bg-[#f2f5f8]",
    );
    expect(screen.getByTestId("location-use-case-checkin").className).toContain(
      "bg-[#f4f6f8]",
    );
    expect(screen.getByTestId("location-use-case-sos").className).toContain(
      "bg-[#fff3f2]",
    );

    const checkInCard = screen.getByTestId("location-use-case-checkin");
    expect(checkInCard.querySelector("[data-one-checkin-pin]")).toBeTruthy();
    const hotelArt = checkInCard.querySelector(
      'img[src="/one-location/onboarding/feature-checkin-house-transparent.webp"]',
    );
    const hotelFrame = checkInCard.querySelector("[data-one-checkin-art]");
    expect(hotelArt).toBeTruthy();
    expect(hotelFrame?.className).toContain("w-[54%]");
    expect(hotelFrame).toHaveStyle({
      perspective: "320px",
      perspectiveOrigin: "50% 100%",
    });
    expect(hotelArt).toHaveStyle({ transform: "rotateY(8deg)" });
    expect(hotelArt?.className).not.toContain("rotate-");

    const shareCard = screen.getByTestId("location-use-case-trip");
    for (const asset of [
      "feature-share-person-1.webp",
      "feature-share-person-2.webp",
      "feature-share-person-3.webp",
    ]) {
      expect(
        shareCard.querySelector(`img[src="/one-location/onboarding/${asset}"]`),
      ).toBeTruthy();
    }
    expect(shareCard.querySelector('img[src*="/orbit-person-"]')).toBeNull();

    expect(screen.getByRole("button", { name: "Add my people" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(screen.queryByText("Connected Person")).toBeNull();
  });

  it("lets Skip leave the add-people screen without choosing anyone", () => {
    // Skip used to call the Continue handler, which rejects an empty selection
    // with "Choose at least one contact" -- so the button offered a way out and
    // then refused to take it. Needing a contact to finish setup is the exact
    // friction this screen should avoid; contacts can be added later from
    // Connect.
    const props = renderFlow();
    openPeopleScreen();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(props.onSkip).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(props.onSendConnectionRequests).not.toHaveBeenCalled();
  });


  it("requests only missing permissions as screen two opens", () => {
    const props = renderFlow();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    expect(props.onLocationReady).not.toHaveBeenCalled();
    expect(props.onRequestNotifications).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Add my people" }));
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
    await waitFor(() => expect(props.onLocationReady).toHaveBeenCalledTimes(1));
    expect(props.onRequestNotifications).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add my people" }),
      ).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add my people" }));
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

    await waitFor(() => expect(props.onLocationReady).toHaveBeenCalledTimes(1));
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add my people" }),
      ).toBeEnabled(),
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
    expect(
      screen.getByRole("button", { name: "Add my people" }),
    ).toBeDisabled();
    expect(screen.queryByTestId("one-location-onboarding-people")).toBeNull();

    await act(async () => {
      resolvePreparation?.(true);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add my people" }),
      ).toBeEnabled(),
    );
  });

  it("keeps setup on screen two until required Location access is ready", () => {
    const props = renderFlow({ requireLocationToComplete: true });

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("button", { name: "Add my people" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add my people" }));

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

  it("keeps the user on contact selection and explains why one person is required", () => {
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
      screen.getByText("Select at least one person to continue"),
    ).toBeTruthy();

    fireEvent.click(continueButton);
    expect(toast.error).toHaveBeenCalledWith(
      "Choose at least one contact",
      {
        description:
          "One Location works best with someone in your circle. You can update contacts later from the Connect tab.",
      },
    );
    expect(props.onSendConnectionRequests).not.toHaveBeenCalled();
    expect(screen.getByTestId("one-location-onboarding-people")).toBeTruthy();
    expect(
      screen.queryByTestId("one-location-onboarding-circle"),
    ).toBeNull();
  });

  it("allows the user to continue after selecting exactly one person", () => {
    const props = renderFlow({
      people: [people[1]!],
      connections: [],
    });
    openPeopleScreen();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Add New Person" }));
    expect(continueButton).toBeEnabled();
    expect(screen.getByText("1 selected")).toBeTruthy();

    fireEvent.click(continueButton);
    expect(toast.error).not.toHaveBeenCalled();
    expect(props.onSendConnectionRequests).toHaveBeenCalledWith(["new_user"]);
    expect(screen.getByTestId("one-location-onboarding-circle")).toBeTruthy();
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
    expect(screen.queryByText("Add more")).toBeNull();
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999);
    });
    expect(props.onComplete).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not resend a successful invitation after returning from the circle", async () => {
    const props = renderFlow();
    openPeopleScreen();
    fireEvent.click(screen.getByRole("button", { name: "Add New Person" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Go back" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(props.onSendConnectionRequests).toHaveBeenCalledTimes(1);
    expect(props.onSendConnectionRequests).toHaveBeenCalledWith(["new_user"]);
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
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("keeps Back and Skip available throughout the onboarding flow", () => {
    const props = renderFlow();
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add my people" }));

    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(props.onSkip).not.toHaveBeenCalled();
  });

  it("uses Back to return to the preceding onboarding screen", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("one-location-onboarding-welcome")).toBeTruthy();

    openPeopleScreen();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("one-location-onboarding-circle")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("one-location-onboarding-people")).toBeTruthy();
  });

  it("delegates feature Back when onboarding starts at permissions", () => {
    const props = renderFlow({ startAt: "permissions" });

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it("lets final-screen Skip exit without racing the completion timer", async () => {
    vi.useFakeTimers();
    const props = renderFlow();
    openPeopleScreen();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(props.onSkip).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(props.onComplete).not.toHaveBeenCalled();
  });

  it("reschedules completion when a slow final-screen Skip fails after the original timer", async () => {
    vi.useFakeTimers();
    let rejectSkip: ((reason: Error) => void) | undefined;
    const onSkip = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSkip = reject;
        }),
    );
    const props = renderFlow({ onSkip });
    openPeopleScreen();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(props.onComplete).not.toHaveBeenCalled();

    await act(async () => {
      rejectSkip?.(new Error("temporary"));
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(props.onComplete).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });

  it("cancels final completion when Back returns to people", async () => {
    vi.useFakeTimers();
    const props = renderFlow();
    openPeopleScreen();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("one-location-onboarding-people")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(props.onComplete).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole("button", { name: "Add my people" }));
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

  describe("circle invite screen (third screen)", () => {
    const invite = {
      circleId: "circle-1",
      circleName: "Meena Family",
      code: "ABCDEFGHJKLM",
    };

    it("shows the invite code before the contact list and lets the user copy/share it", async () => {
      const onPrepareOnboardingCircleInvite = vi
        .fn()
        .mockResolvedValue(invite);
      const onCopyOnboardingCircleCode = vi.fn();
      const onShareOnboardingCircleCode = vi.fn();
      renderFlow({
        onPrepareOnboardingCircleInvite,
        onCopyOnboardingCircleCode,
        onShareOnboardingCircleCode,
      });

      // welcome -> features
      fireEvent.click(screen.getByRole("button", { name: "Get started" }));
      // features -> invite (NOT people, because the invite screen is enabled)
      fireEvent.click(screen.getByRole("button", { name: "Add my people" }));

      expect(
        screen.getByTestId("one-location-onboarding-invite"),
      ).toBeTruthy();
      expect(onPrepareOnboardingCircleInvite).toHaveBeenCalledTimes(1);

      await waitFor(() =>
        expect(
          screen.getByTestId("one-location-onboarding-invite-code")
            .textContent,
        ).toContain("ABCD-EFGH-JKLM"),
      );
      expect(screen.getByText("Meena Family")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
      expect(onCopyOnboardingCircleCode).toHaveBeenCalledWith(
        "ABCDEFGHJKLM",
      );

      fireEvent.click(screen.getByRole("button", { name: /Share/ }));
      expect(onShareOnboardingCircleCode).toHaveBeenCalledWith(invite);

      // Continue advances from the invite screen to the contact list.
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByTestId("one-location-onboarding-people")).toBeTruthy();
    });

    it("surfaces a retry when preparing the code fails", async () => {
      const onPrepareOnboardingCircleInvite = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValue(invite);
      renderFlow({ onPrepareOnboardingCircleInvite });

      fireEvent.click(screen.getByRole("button", { name: "Get started" }));
      fireEvent.click(screen.getByRole("button", { name: "Add my people" }));

      await waitFor(() =>
        expect(screen.getByText("temporary")).toBeTruthy(),
      );

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() =>
        expect(onPrepareOnboardingCircleInvite).toHaveBeenCalledTimes(2),
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("one-location-onboarding-invite-code")
            .textContent,
        ).toContain("ABCD-EFGH-JKLM"),
      );
    });

    it("skips the invite screen entirely when no prepare handler is provided", () => {
      renderFlow();
      fireEvent.click(screen.getByRole("button", { name: "Get started" }));
      fireEvent.click(screen.getByRole("button", { name: "Add my people" }));
      // With no onPrepareOnboardingCircleInvite, Continue goes straight to the
      // contact list — the invite screen never appears.
      expect(screen.getByTestId("one-location-onboarding-people")).toBeTruthy();
      expect(
        screen.queryByTestId("one-location-onboarding-invite"),
      ).toBeNull();
    });
  });
});
