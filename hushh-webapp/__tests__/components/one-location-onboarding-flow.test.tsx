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
import { READY_PANEL_CLASSNAME } from "@/components/one-location/onboarding/ready-panel-layout";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

const invite = {
  circleId: "circle-1",
  circleName: "Meena Family",
  code: "ABCDEFGHJKLM",
};

function renderFlow(
  overrides: Partial<
    React.ComponentProps<typeof OneLocationOnboardingFlow>
  > = {},
) {
  const props: React.ComponentProps<typeof OneLocationOnboardingFlow> = {
    startAt: "welcome",
    currentUserName: "Test User",
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

/** welcome -> features -> contacts. */
function openContactsScreen() {
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
}

/** ...and on to the invite screen, declining the contacts step. */
function openInviteScreen() {
  openContactsScreen();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
}

/** The terminal CTA, whose label the parent supplies per mode. */
function finishButton() {
  return screen.getByRole("button", { name: "Open One Location" });
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

  it("keeps Back and Skip clear of the iOS status bar on every screen", () => {
    // The notch and the clock live at the top of every modern iPhone. These two
    // controls are the only way backwards, so putting them under it is worse
    // than ugly -- they become findable only by guessing.
    //
    // min-h, never a fixed h: a fixed-height header shrinks its content box as
    // the inset grows, and a vertically centred button then overflows UPWARD.
    // Adding clearance moved the buttons higher, which is how this was missed.
    renderFlow({ contactsStepAvailable: true });
    const headerOf = (testId: string) =>
      screen.getByTestId(testId).querySelector("header") ??
      screen.getByTestId(testId).querySelector("nav");

    const advance = [
      ["one-location-onboarding-welcome", "Get started"],
      ["one-location-onboarding-features", "Find my people"],
      ["one-location-onboarding-contacts", "Not now"],
      ["one-location-onboarding-invite", null],
    ] as const;

    for (const [testId, next] of advance) {
      const surface = screen.getByTestId(testId);
      const header = headerOf(testId);
      const inset =
        (header?.className ?? "") + " " + (surface.firstElementChild?.className ?? "");
      expect(inset).toContain("--app-safe-area-top-effective");
      if (header) expect(header.className).not.toMatch(/h-16/u);
      if (next) fireEvent.click(screen.getByRole("button", { name: next }));
    }
  });

  it("keeps visual intro canvases full width while dense steps hold one column", () => {
    // Features used to size off viewport height and widen to 3xl on a large
    // window, so on desktop the panel visibly jumped wider on step two and
    // back again on step three -- the surface changing shape under the person
    // as they advanced through it.
    renderFlow({ contactsStepAvailable: true });
    const widths: string[] = [];
    const record = (testId: string) => {
      const cls = screen.getByTestId(testId).className;
      widths.push(/max-w-\[[^\]]+\]/u.exec(cls)?.[0] ?? "none");
    };

    record("one-location-onboarding-welcome");
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    record("one-location-onboarding-features");
    fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
    record("one-location-onboarding-contacts");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    record("one-location-onboarding-invite");

    expect(widths).toEqual([
      "none",
      "none",
      "max-w-[430px]",
      "none",
    ]);
  });

  it("keeps the mobile feature screen readable without forced card compression", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    const featureShell = screen.getByTestId("one-location-onboarding-features");
    expect(featureShell.className).toContain("max-w-none");
    expect(featureShell.className).not.toContain("md:max-w-[920px]");
    const featureSurface = featureShell.firstElementChild;
    expect(featureSurface?.className).toContain("max-w-[430px]");
    expect(featureSurface?.className).toContain("max-[431px]:max-w-none");
    expect(featureSurface?.className).toContain("overflow-hidden");
    expect(featureSurface?.className).toContain("flex-col");
    expect(featureSurface?.className).toContain("bg-white");
    expect(featureSurface?.className).toContain("px-5");
    expect(featureSurface?.className).toContain("sm:px-8");
    expect(featureSurface?.className).toContain(
      "pt-[max(var(--app-safe-area-top-effective,0px),12px)]",
    );

    const featureScroll = document.querySelector("[data-one-feature-scroll]");
    expect(featureScroll?.className).toContain("overflow-y-auto");
    expect(featureScroll?.className).toContain("overflow-x-hidden");
    expect(featureScroll?.className).toContain("flex-col");
    expect(featureScroll?.className).toContain("flex-1");
    const featureGrid = document.querySelector("[data-one-feature-grid]");
    expect(featureGrid?.className).toContain("mt-6");
    expect(featureGrid?.className).toContain("shrink-0");
    const lowerGrid = document.querySelector("[data-one-feature-lower-grid]");
    expect(lowerGrid?.className).toContain("grid-cols-2");
    // mt-3, not mt-4. The subtitle spacing was tightened in the shipped
    // component but this assertion was never updated, so it has been failing
    // on main independently of this change. Matched to what actually renders.
    expect(
      document.querySelector("[data-one-feature-subtitle]")?.className,
    ).toContain("mt-3");
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
    expect(responsiveStyles).toContain("grid-template-rows: auto");
    expect(responsiveStyles).not.toContain(
      "grid-template-rows: minmax(0, 0.82fr) minmax(0, 1fr)",
    );
    expect(responsiveStyles).toContain("@media (min-width: 768px)");
    expect(responsiveStyles).toContain("flex: 0 0 auto");
    expect(responsiveStyles).toContain(
      "font-size: clamp(14px, 9.5cqw, 15px)",
    );
    expect(responsiveStyles).toContain("--foundation-title1-size: 34px");
    expect(responsiveStyles).not.toContain(
      "--foundation-title1-size: clamp(36px, 3vw, 40px)",
    );
    expect(responsiveStyles).not.toContain("aspect-ratio: 2.5 / 1");
    expect(responsiveStyles).not.toContain("aspect-ratio: 1.6 / 1");
    expect(responsiveStyles).toContain("grid-template-areas:");
    expect(responsiveStyles).toContain("aspect-ratio: auto");
    expect(responsiveStyles).toContain(
      "grid-template-columns: repeat(3, minmax(0, 1fr))",
    );
    expect(responsiveStyles).toContain('"share checkin sms"');
    expect(responsiveStyles).toContain("min-height: 390px");
    expect(responsiveStyles).not.toContain("width: 58%");
    expect(responsiveStyles).toContain("font-size: 20px");
    expect(responsiveStyles).toContain("font-size: 15px");
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
    ).toEqual(["Can\u2019t explain", "where you are?"]);
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
      screen.getByRole("heading", { name: "Need to keep people updated?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Share location, check in, or send help in seconds.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Can\u2019t explain where you are?",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Share once. Your Circle can find you safely."),
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
    expect(screen.getByText("Alerted 3 contacts")).toBeTruthy();

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
    expect(checkInCard.querySelector("[data-one-checkin-pin]")).toBeNull();
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

    expect(screen.getByRole("button", { name: "Find my people" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(screen.queryByText("Connected Person")).toBeNull();
  });


  it("requests only missing permissions as screen two opens", () => {
    const props = renderFlow();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(props.onRequestLocation).toHaveBeenCalledTimes(1);
    expect(props.onLocationReady).not.toHaveBeenCalled();
    expect(props.onRequestNotifications).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
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
        screen.getByRole("button", { name: "Find my people" }),
      ).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
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
        screen.getByRole("button", { name: "Find my people" }),
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
      screen.getByRole("button", { name: "Find my people" }),
    ).toBeDisabled();
    expect(screen.queryByTestId("one-location-onboarding-people")).toBeNull();

    await act(async () => {
      resolvePreparation?.(true);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Find my people" }),
      ).toBeEnabled(),
    );
  });

  it("keeps setup on screen two until required Location access is ready", () => {
    const props = renderFlow({ requireLocationToComplete: true });

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("button", { name: "Find my people" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find my people" }));

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


  it("completes from the invite screen on one press, and never on its own", async () => {
    vi.useFakeTimers();
    const props = renderFlow();
    openInviteScreen();

    expect(screen.getByTestId("one-location-onboarding-invite")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /You're on the map/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    // This screen used to finish itself on a 4s timer. Waiting must now do
    // nothing at all -- leaving is the person's decision.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(props.onComplete).not.toHaveBeenCalled();

    fireEvent.click(finishButton());
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });

  it("ignores a second press while completion is still in flight", () => {
    const onComplete = vi.fn(() => new Promise<void>(() => {}));
    renderFlow({ onComplete });
    openInviteScreen();

    fireEvent.click(finishButton());
    fireEvent.click(finishButton());

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("re-arms the finish CTA after a transient durable-settlement failure", async () => {
    const onComplete = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(undefined);
    renderFlow({ onComplete });
    openInviteScreen();

    fireEvent.click(finishButton());
    expect(onComplete).toHaveBeenCalledTimes(1);

    // A rejected settlement must release the in-flight latch, or the person is
    // stranded on a screen whose only button no longer does anything.
    await waitFor(() => expect(finishButton()).toBeEnabled());
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    fireEvent.click(finishButton());
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("keeps Back and Skip available throughout the onboarding flow", () => {
    const props = renderFlow();
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find my people" }));

    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(props.onSkip).not.toHaveBeenCalled();
  });

  it("uses Back to return to the preceding onboarding screen", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("one-location-onboarding-welcome")).toBeTruthy();

    openInviteScreen();
    expect(screen.getByTestId("one-location-onboarding-invite")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("one-location-onboarding-contacts")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
  });

  it("delegates feature Back when onboarding starts at permissions", () => {
    const props = renderFlow({ startAt: "permissions" });

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it("lets final-screen Skip exit without completion overtaking it", async () => {
    vi.useFakeTimers();
    const props = renderFlow();
    openInviteScreen();

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
    openInviteScreen();

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

    // A failed Skip must leave the person able to finish instead: the CTA is
    // the only way off this screen now, so it cannot stay latched shut.
    expect(props.onComplete).not.toHaveBeenCalled();
    fireEvent.click(finishButton());
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not complete when Back leaves the final screen", async () => {
    vi.useFakeTimers();
    const props = renderFlow();
    openInviteScreen();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("one-location-onboarding-contacts")).toBeTruthy();

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

    fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
    const contactsScreen = screen.getByTestId(
      "one-location-onboarding-contacts",
    );
    expect(contactsScreen.firstElementChild?.className).toContain(
      "dark:bg-[#14171d]",
    );

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    const inviteScreen = screen.getByTestId("one-location-onboarding-invite");
    expect(inviteScreen.firstElementChild?.className).toContain(
      "dark:bg-[#14171d]",
    );
  });

  describe("joining someone else's circle", () => {
    const preview = {
      name: "Meena Family",
      ownerDisplayName: "Meena",
      memberCount: 4,
      alreadyMember: false,
    };

    function openJoin(
      overrides: Partial<
        React.ComponentProps<typeof OneLocationOnboardingFlow>
      > = {},
    ) {
      const props = renderFlow({
        onPreviewCircleCode: vi.fn().mockResolvedValue(preview),
        onAcceptCircleCode: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      });
      openInviteScreen();
      return props;
    }

    it("shows who is behind a code before asking anyone to join", async () => {
      const props = openJoin();

      fireEvent.click(
        screen.getByText("Someone sent you a code?"),
      );
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "abcd-efgh-jklm" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));

      await waitFor(() =>
        expect(props.onPreviewCircleCode).toHaveBeenCalledWith("abcd-efgh-jklm"),
      );

      // Name, owner and size: deciding to share your location with a group is
      // not a decision to make against an opaque string.
      const card = await screen.findByTestId("onboarding-join-circle-preview");
      expect(card.textContent).toContain("Meena Family");
      expect(card.textContent).toContain("Meena");
      expect(card.textContent).toContain("4 people");
      expect(props.onAcceptCircleCode).not.toHaveBeenCalled();
    });

    it("accepts the circle and says when it will take effect", async () => {
      const props = openJoin();

      fireEvent.click(screen.getByText("Someone sent you a code?"));
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "ABCDEFGHJKLM" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));
      fireEvent.click(
        await screen.findByRole("button", { name: /Join Meena Family/ }),
      );

      await waitFor(() =>
        expect(props.onAcceptCircleCode).toHaveBeenCalledWith("ABCDEFGHJKLM"),
      );
      // Honest about the delay rather than claiming a join that has not
      // happened: the redeem waits for the vault the wizard has yet to create.
      expect(
        await screen.findByText(/join Meena Family as soon as One finishes/i),
      ).toBeTruthy();
    });

    it("lines the join card up with the invite card stacked above it", async () => {
      openJoin({
        onPrepareOnboardingCircleInvite: vi.fn().mockResolvedValue(invite),
      });

      fireEvent.click(screen.getByText("Someone sent you a code?"));
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "ABCDEFGHJKLM" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));

      const inviteCard = screen.getByTestId(
        "one-location-onboarding-invite-card",
      );
      const joinCard = await screen.findByTestId(
        "onboarding-join-circle-preview",
      );

      // These two are siblings at the same width, so any difference in inset
      // or radius shows up as a ragged left edge down the panel -- the join
      // card used to sit 4px inside the code card's text column.
      for (const geometry of ["p-5", "rounded-[20px]"]) {
        expect(inviteCard.className).toContain(geometry);
        expect(joinCard.className).toContain(geometry);
      }
    });

    it("keeps the accepted confirmation on the same left edge as the cards", async () => {
      openJoin({
        onPrepareOnboardingCircleInvite: vi.fn().mockResolvedValue(invite),
      });

      fireEvent.click(screen.getByText("Someone sent you a code?"));
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "ABCDEFGHJKLM" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));
      fireEvent.click(
        await screen.findByRole("button", { name: /Join Meena Family/ }),
      );

      const confirmation = await screen.findByRole("status");
      // The confirmation replaces the join card in place. Its horizontal inset
      // has to match, or the panel's left edge jumps the moment someone joins.
      expect(confirmation.className).toContain("px-5");
      expect(confirmation.className).toContain("rounded-[20px]");
    });

    it("does not offer to join a circle the person is already in", async () => {
      const props = openJoin({
        onPreviewCircleCode: vi
          .fn()
          .mockResolvedValue({ ...preview, alreadyMember: true }),
      });

      fireEvent.click(screen.getByText("Someone sent you a code?"));
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "ABCDEFGHJKLM" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));

      expect(
        await screen.findByText("You're already in this circle."),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /Join Meena Family/ }),
      ).toBeNull();
      expect(props.onAcceptCircleCode).not.toHaveBeenCalled();
    });

    it("surfaces a bad code without blocking the way out", async () => {
      const props = openJoin({
        onPreviewCircleCode: vi
          .fn()
          .mockRejectedValue(new Error("That code has expired.")),
      });

      fireEvent.click(screen.getByText("Someone sent you a code?"));
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "NOPENOPENOPE" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));

      expect(await screen.findByText("That code has expired.")).toBeTruthy();
      expect(
        screen.queryByTestId("onboarding-join-circle-preview"),
      ).toBeNull();

      // A wrong code is not a dead end.
      fireEvent.click(finishButton());
      expect(props.onComplete).toHaveBeenCalledTimes(1);
    });

    it("refuses your own code without spending a lookup on it", async () => {
      const onPreviewCircleCode = vi.fn();
      const props = openJoin({
        onPreviewCircleCode,
        onPrepareOnboardingCircleInvite: vi.fn().mockResolvedValue(invite),
      });

      await waitFor(() =>
        expect(
          screen.getByTestId("one-location-onboarding-invite-code").textContent,
        ).toContain("ABCD-EFGH-JKLM"),
      );

      fireEvent.click(screen.getByText("Someone sent you a code?"));
      // Typed the way it is displayed, dashes and all.
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "abcd-efgh-jklm" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));

      // Your own code resolves to a circle you already own, so the generic
      // "already a member" would be true and useless. And there is nothing to
      // look up, so no request is made.
      expect(await screen.findByText(/that's your own code/i)).toBeTruthy();
      expect(onPreviewCircleCode).not.toHaveBeenCalled();
      expect(props.onComplete).not.toHaveBeenCalled();
    });

    it("lets the person back out of a preview to try another code", async () => {
      const props = openJoin();

      fireEvent.click(screen.getByText("Someone sent you a code?"));
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "ABCDEFGHJKLM" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));
      expect(
        await screen.findByTestId("onboarding-join-circle-preview"),
      ).toBeTruthy();

      // Previewing replaces the input, so without a way back a wrong code
      // stranded the person looking at someone else's circle.
      fireEvent.click(
        screen.getByTestId("onboarding-join-circle-reset"),
      );

      expect(
        screen.queryByTestId("onboarding-join-circle-preview"),
      ).toBeNull();
      const field = screen.getByLabelText("Circle code") as HTMLInputElement;
      // The typed code survives, so fixing one wrong character is an edit
      // rather than retyping all twelve.
      expect(field.value).toBe("ABCDEFGHJKLM");

      fireEvent.change(field, { target: { value: "MNPQRSTUVWXY" } });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));
      await waitFor(() =>
        expect(props.onPreviewCircleCode).toHaveBeenLastCalledWith(
          "MNPQRSTUVWXY",
        ),
      );
    });

    it("clears a failed lookup when the code is edited", async () => {
      openJoin({
        onPreviewCircleCode: vi
          .fn()
          .mockRejectedValue(new Error("That code has expired.")),
      });

      fireEvent.click(screen.getByText("Someone sent you a code?"));
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "NOPENOPENOPE" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Look up/ }));
      expect(await screen.findByText("That code has expired.")).toBeTruthy();

      // A stale error next to a freshly typed code reads as a verdict on the
      // new one.
      fireEvent.change(screen.getByLabelText("Circle code"), {
        target: { value: "ABCDEFGHJKLM" },
      });
      expect(screen.queryByText("That code has expired.")).toBeNull();
    });

    it("is hidden when the parent cannot resolve codes", () => {
      renderFlow();
      openInviteScreen();

      expect(screen.queryByTestId("onboarding-join-circle")).toBeNull();
    });
  });

  describe("contacts screen", () => {
    const matches = [
      { userId: "user_b", displayName: "Trusted B" },
      { userId: "user_c", displayName: "Advisor C" },
    ];

    it("does not touch the address book until the person asks", () => {
      const onSyncOnboardingContacts = vi
        .fn()
        .mockResolvedValue({ status: "matched", matches });
      renderFlow({ onSyncOnboardingContacts });
      openContactsScreen();

      // The OS contacts prompt is the single most declinable moment in the
      // flow. Firing it on mount is what makes people say no; it fires on tap.
      expect(onSyncOnboardingContacts).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Check my contacts" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    });

    it("shows matched contacts and adds one on request", async () => {
      const onSyncOnboardingContacts = vi
        .fn()
        .mockResolvedValue({ status: "matched", matches });
      const onAddOnboardingContact = vi.fn().mockResolvedValue(undefined);
      renderFlow({ onSyncOnboardingContacts, onAddOnboardingContact });
      openContactsScreen();

      fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

      expect(await screen.findByText("Trusted B")).toBeTruthy();
      expect(screen.getByText("Advisor C")).toBeTruthy();

      const addButtons = screen.getAllByRole("button", { name: "Add" });
      fireEvent.click(addButtons[0]!);

      await waitFor(() =>
        expect(onAddOnboardingContact).toHaveBeenCalledWith("user_b"),
      );
      expect(await screen.findByRole("button", { name: /Requested/ })).toBeTruthy();
      // Adding someone is not leaving the flow.
      expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    });

    it("keeps a failed add retryable instead of marking it done", async () => {
      const onSyncOnboardingContacts = vi
        .fn()
        .mockResolvedValue({ status: "matched", matches });
      const onAddOnboardingContact = vi
        .fn()
        .mockRejectedValue(new Error("network"));
      renderFlow({ onSyncOnboardingContacts, onAddOnboardingContact });
      openContactsScreen();
      fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

      const addButtons = await screen.findAllByRole("button", { name: "Add" });
      fireEvent.click(addButtons[0]!);

      await waitFor(() => expect(onAddOnboardingContact).toHaveBeenCalled());
      // The row must not claim success, and must not stay stuck on "Adding".
      await waitFor(() =>
        expect(screen.getAllByRole("button", { name: "Add" }).length).toBe(2),
      );
    });

    it("says so plainly when nobody matched, and still moves on", async () => {
      const onSyncOnboardingContacts = vi
        .fn()
        .mockResolvedValue({ status: "none", partial: false });
      renderFlow({ onSyncOnboardingContacts });
      openContactsScreen();
      fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

      expect(
        await screen.findByText(/None of your contacts are on One yet/i),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByTestId("one-location-onboarding-invite")).toBeTruthy();
    });

    it("does not claim nobody matched when only part of the book was read", async () => {
      const onSyncOnboardingContacts = vi
        .fn()
        .mockResolvedValue({ status: "none", partial: true });
      renderFlow({ onSyncOnboardingContacts });
      openContactsScreen();
      fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

      // iOS limited access and the web picker return a hand-picked subset, so
      // an empty result is inconclusive and must not be reported as a whole
      // address book that came back empty.
      expect(
        await screen.findByText(/contacts you shared are on One yet/i),
      ).toBeTruthy();
      expect(screen.queryByText(/None of your contacts/i)).toBeNull();
    });

    it("offers Settings when permission was declined, and never traps", async () => {
      const onSyncOnboardingContacts = vi.fn().mockResolvedValue({
        status: "failed",
        message: "One does not have access to your contacts yet.",
        canOpenSettings: true,
      });
      const onOpenContactSettings = vi.fn();
      renderFlow({ onSyncOnboardingContacts, onOpenContactSettings });
      openContactsScreen();
      fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

      expect(
        await screen.findByText(/does not have access to your contacts/i),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
      expect(onOpenContactSettings).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByTestId("one-location-onboarding-invite")).toBeTruthy();
    });

    it("recovers when the sync itself throws", async () => {
      const onSyncOnboardingContacts = vi
        .fn()
        .mockRejectedValue(new Error("plugin exploded"));
      renderFlow({ onSyncOnboardingContacts });
      openContactsScreen();
      fireEvent.click(screen.getByRole("button", { name: "Check my contacts" }));

      expect(await screen.findByText("plugin exploded")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByTestId("one-location-onboarding-invite")).toBeTruthy();
    });

    it("is skipped entirely where no address book can be read", () => {
      // A desktop browser has nothing to read. Rendering the step there means a
      // screen whose whole content is "this does not work here" -- a wasted tap
      // that reads as a dead end. Where it cannot work, it does not exist.
      const onSyncOnboardingContacts = vi.fn();
      renderFlow({ contactsStepAvailable: false, onSyncOnboardingContacts });

      fireEvent.click(screen.getByRole("button", { name: "Get started" }));
      fireEvent.click(screen.getByRole("button", { name: "Find my people" }));

      expect(screen.getByTestId("one-location-onboarding-invite")).toBeTruthy();
      expect(
        screen.queryByTestId("one-location-onboarding-contacts"),
      ).toBeNull();
      expect(onSyncOnboardingContacts).not.toHaveBeenCalled();
    });

    it("sends Back to the features screen when the step is skipped", () => {
      renderFlow({ contactsStepAvailable: false });

      fireEvent.click(screen.getByRole("button", { name: "Get started" }));
      fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
      fireEvent.click(screen.getByRole("button", { name: "Go back" }));

      // Back must not land on a screen that was never shown.
      expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    });

    it("still completes when the step is skipped", () => {
      const props = renderFlow({ contactsStepAvailable: false });

      fireEvent.click(screen.getByRole("button", { name: "Get started" }));
      fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
      fireEvent.click(finishButton());

      expect(props.onComplete).toHaveBeenCalledTimes(1);
    });

    it("lets Skip leave from the contacts screen without syncing", () => {
      const onSyncOnboardingContacts = vi.fn();
      const props = renderFlow({ onSyncOnboardingContacts });
      openContactsScreen();

      fireEvent.click(screen.getByRole("button", { name: "Skip" }));

      expect(props.onSkip).toHaveBeenCalledTimes(1);
      expect(onSyncOnboardingContacts).not.toHaveBeenCalled();
      expect(props.onComplete).not.toHaveBeenCalled();
    });
  });

  describe("circle invite screen (final screen)", () => {
    it("shows the invite code and lets the user copy/share it", async () => {
      const onPrepareOnboardingCircleInvite = vi
        .fn()
        .mockResolvedValue(invite);
      const onCopyOnboardingCircleCode = vi.fn();
      const onShareOnboardingCircleCode = vi.fn();
      const props = renderFlow({
        onPrepareOnboardingCircleInvite,
        onCopyOnboardingCircleCode,
        onShareOnboardingCircleCode,
      });

      openInviteScreen();

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
      expect(screen.getByText(/Bring your people to Meena Family/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
      expect(onCopyOnboardingCircleCode).toHaveBeenCalledWith(
        "ABCDEFGHJKLM",
      );

      fireEvent.click(screen.getByRole("button", { name: /Share/ }));
      expect(onShareOnboardingCircleCode).toHaveBeenCalledWith(invite);

      // Copying and sharing are optional; neither ends onboarding.
      expect(props.onComplete).not.toHaveBeenCalled();
      fireEvent.click(finishButton());
      expect(props.onComplete).toHaveBeenCalledTimes(1);
    });

    it("surfaces a retry when preparing the code fails", async () => {
      const onPrepareOnboardingCircleInvite = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValue(invite);
      renderFlow({ onPrepareOnboardingCircleInvite });

      openInviteScreen();

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

    it("still shows the invite screen, and still completes, with no prepare handler", () => {
      // This used to assert the opposite: no handler meant the screen was
      // dropped from the sequence entirely. In the pre-vault setup journey the
      // handler was always absent, so the one screen onboarding exists to show
      // was invisible to every genuinely new person. A contract-governed screen
      // must not vanish because a prop is missing -- it degrades in place.
      const props = renderFlow();
      openInviteScreen();

      expect(screen.getByTestId("one-location-onboarding-invite")).toBeTruthy();
      expect(screen.getByText(/circle code will be ready/i)).toBeTruthy();

      fireEvent.click(finishButton());
      expect(props.onComplete).toHaveBeenCalledTimes(1);
    });

    it("ends on the map, with the code resting on it rather than gating it", () => {
      const props = renderFlow({
        mapPoint: { lat: 19.076, lng: 72.8777 },
        onPrepareOnboardingCircleInvite: vi.fn().mockResolvedValue(invite),
      });
      openInviteScreen();

      // The payoff is seeing yourself on a map, not being handed an errand.
      expect(
        screen.getByRole("heading", { name: /You're on the map/ }),
      ).toBeTruthy();
      expect(screen.getByTestId("onboarding-live-map")).toBeTruthy();

      // The empty seat, which is the only thing here the map cannot show by
      // itself and the reason the code below matters.
      expect(screen.getByTestId("onboarding-ready-empty-seat")).toBeTruthy();

      // And explicitly NOT a second telling of Share / Check in / SOS: the
      // features screen already introduces those, and repeating them turns the
      // payoff into a summary slide.
      expect(screen.queryByText("Share where you are")).toBeNull();
      expect(screen.queryByText("Check in when you arrive")).toBeNull();
      expect(screen.queryByText("Send an SOS")).toBeNull();

      // Nothing here blocks leaving.
      expect(props.onComplete).not.toHaveBeenCalled();
      fireEvent.click(finishButton());
      expect(props.onComplete).toHaveBeenCalledTimes(1);
    });

    it("never lays copy over live map tiles", () => {
      renderFlow({ mapPoint: { lat: 19.076, lng: 72.8777 } });
      openInviteScreen();

      const map = screen.getByTestId("onboarding-live-map");
      const seat = screen.getByTestId("onboarding-ready-empty-seat");
      const sheet = screen.getByTestId("one-location-onboarding-ready-panel");

      // The map owns a band of its own; the words sit on an opaque sheet below
      // it. A translucent scrim over live tiles is a contrast gamble that dense
      // city streets win, and the copy loses.
      expect(map.className).toContain("shrink-0");
      expect(map.className).toContain("md:absolute");
      expect(map.className).not.toMatch(/(^|\s)absolute(\s|$)/u);
      expect(sheet?.className).toContain("bg-white");
      expect(sheet?.className).not.toMatch(/bg-white\/\d/u);
      expect(map.contains(seat)).toBe(false);
    });

    it("centers the invite panel on wide viewports instead of pinning it right", () => {
      renderFlow({ mapPoint: { lat: 19.076, lng: 72.8777 } });
      openInviteScreen();

      const sheet = screen.getByTestId("one-location-onboarding-ready-panel");

      // The panel must render the shared contract verbatim -- that is what
      // e2e/one-location-ready-panel.layout.spec.ts measures in a real browser.
      // JSDOM performs no layout, so this half only proves the classes reach
      // the DOM; the browser half proves they actually centre the box.
      expect(sheet.className).toBe(READY_PANEL_CLASSNAME);

      // It reads as a dialog over the map, so it belongs in the middle of it.
      // Anchored to the right edge it looked like a panel that had slid off.
      expect(sheet.className).toContain("md:left-1/2");
      expect(sheet.className).toContain("md:-translate-x-1/2");
      expect(sheet.className).toContain("md:top-1/2");
      expect(sheet.className).toContain("md:-translate-y-1/2");
      expect(sheet.className).not.toMatch(/md:right-/u);

      // Phone width -- which is what the iOS build renders at -- keeps the
      // full-width bottom sheet untouched. The centering is a md: concern only.
      expect(sheet.className).not.toMatch(/(^|\s)left-1\/2(\s|$)/u);
      expect(sheet.className).not.toMatch(/(^|\s)absolute(\s|$)/u);
    });

    it("yields map height on short windows so the join link stays on screen", () => {
      renderFlow({ mapPoint: { lat: 19.076, lng: 72.8777 } });
      openInviteScreen();

      const surface = screen.getByTestId(
        "one-location-onboarding-ready-surface",
      );
      const styles = Array.from(surface.querySelectorAll("style"))
        .map((n) => n.textContent ?? "")
        .join(" ");

      // 34dvh of map is right on a phone, which is tall. A 1366x768 laptop is
      // shorter than an iPhone, and there the same fraction pushed "Someone
      // sent you a code?" below the fold -- the last thing on the screen took
      // a scroll to discover it existed. The map yields, not the content.
      expect(styles).toContain("max-height: 820px");
      expect(styles).toContain("24dvh");
    });

    it("renders a composed map even with no point and no Maps key", () => {
      // A missing or referrer-blocked browser key is common enough that it is
      // the entire local-dev story. The last screen must still look finished:
      // onboarding cannot end on an error panel.
      renderFlow({ mapPoint: null });
      openInviteScreen();

      const map = screen.getByTestId("onboarding-live-map");
      expect(map.getAttribute("data-map-state")).toBe("stylised");
      expect(
        screen.getByRole("heading", { name: /You're on the map/ }),
      ).toBeTruthy();
      expect(finishButton()).toBeEnabled();
    });

    it("keeps the reveal decorative, so reduced motion loses nothing", () => {
      renderFlow({ mapPoint: { lat: 19.076, lng: 72.8777 } });
      openInviteScreen();

      const surface = screen.getByTestId(
        "one-location-onboarding-ready-surface",
      );
      // Both blocks matter: the map's pin pulse and the content reveal.
      const styles = Array.from(surface.querySelectorAll("style"))
        .map((node) => node.textContent ?? "")
        .join(" ");
      expect(styles.match(/prefers-reduced-motion: reduce/g)).toHaveLength(2);
      // The animation is an entrance, never a gate: reduced motion resolves it
      // to the finished state rather than removing the content.
      expect(styles).toContain("animation: none");
      expect(styles).toContain("opacity: 1");
    });

    it("keeps the final screen fitted and iOS-safe on a small phone", async () => {
      const onPrepareOnboardingCircleInvite = vi
        .fn()
        .mockResolvedValue(invite);
      renderFlow({ onPrepareOnboardingCircleInvite });
      openInviteScreen();

      const shell = screen.getByTestId("one-location-onboarding-invite")
        .firstElementChild as HTMLElement;
      // Header and footer hold their size; only the middle scrolls. Without
      // min-h-0 the scroll region refuses to shrink and the CTA is pushed off
      // the bottom of a short screen.
      expect(shell.className).toContain("min-h-0");
      const scrollRegion = shell.querySelector("div.overflow-y-auto");
      expect(scrollRegion?.className).toContain("min-h-0");
      expect(scrollRegion?.className).toContain("flex-1");

      const footer = shell.querySelector("footer");
      expect(footer?.className).toContain("shrink-0");
      // The home indicator must never sit on top of the only way forward.
      expect(footer?.className).toContain("env(safe-area-inset-bottom,0px)");

      await waitFor(() =>
        expect(
          screen.getByTestId("one-location-onboarding-invite-code").textContent,
        ).toContain("ABCD-EFGH-JKLM"),
      );
      const code = screen.getByTestId("one-location-onboarding-invite-code");
      // 14 wide-tracked monospace glyphs at a fixed 30px overflow the card on a
      // 390px phone, so the size scales and the code stays on one line.
      expect(code.className).toContain("text-[clamp(20px,6vw,28px)]");
      expect(code.className).toContain("whitespace-nowrap");
    });

    it("uses the label the parent supplies for the terminal CTA", () => {
      const props = renderFlow({ completeLabel: "Finish" });
      openInviteScreen();

      fireEvent.click(screen.getByRole("button", { name: "Finish" }));
      expect(props.onComplete).toHaveBeenCalledTimes(1);
    });
  });
});
