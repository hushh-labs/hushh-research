import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OneLocationOnboardingFlow } from "@/components/one-location/onboarding/one-location-onboarding-flow";

/**
 * The last onboarding screen, locked as a contract.
 *
 * It lives in its own file, and in the CI-registered `verify:one-location`
 * pack, for one reason: the sibling suite
 * `__tests__/components/one-location-onboarding-flow.test.tsx` is not in any
 * pack, so nothing it asserts has ever gated a pull request. That is how a
 * screen shipped for months drawing a decorative grid under a headline that
 * said "You're on the map." -- there were tests, and none of them ran, and the
 * one that could have caught it modelled the bug (its default `mapPoint` was
 * null) rather than the product.
 *
 * Two claims are worth more than the rest here:
 *
 *   1. What the screen SAYS matches what it SHOWS. A headline promising a map
 *      only appears when a map is on screen.
 *   2. Nothing on this screen is a decoration standing in for a fact. No pin
 *      over an unknown place, no grid pretending to be streets.
 */

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const INVITE = {
  circleId: "circle-1",
  circleName: "Meena Family",
  code: "ABCDEFGHJKLM",
};

const MUMBAI = { lat: 19.076, lng: 72.8777 };

function renderFinale(
  overrides: Partial<
    React.ComponentProps<typeof OneLocationOnboardingFlow>
  > = {},
) {
  const props: React.ComponentProps<typeof OneLocationOnboardingFlow> = {
    startAt: "welcome",
    activeScreen: "ready",
    currentUserName: "Ankit",
    // "prompt", not "granted": granting sends the features screen into its
    // save-place preparation, which holds Continue busy and never reaches the
    // finale here. The coordinate this file cares about is injected directly
    // as `mapPoint`, which is what the page hands the flow in production.
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
    mapPoint: MUMBAI,
    onPrepareOnboardingCircleInvite: vi.fn().mockResolvedValue(INVITE),
    onCopyOnboardingCircleCode: vi.fn(),
    onShareOnboardingCircleCode: vi.fn(),
    onPreviewCircleCode: vi.fn(),
    onAcceptCircleCode: vi.fn(),
    ...overrides,
  };

  render(<OneLocationOnboardingFlow {...props} />);

  return props;
}

const map = () => screen.getByTestId("onboarding-live-map");
const finishButton = () =>
  screen.getByRole("button", { name: "Open One Location" });

describe("One Location onboarding finale — the map is real", () => {
  it("draws a map of where the person actually is", () => {
    renderFinale();

    // jsdom has no Google Maps script, which is exactly the state a
    // referrer-blocked key or the iOS `App://` origin produces in production.
    // The answer is the keyless embed every other Location surface degrades to
    // -- a real map, of the real coordinate, not an illustration of one.
    expect(map().getAttribute("data-map-point")).toBe("ready");
    expect(map().getAttribute("data-map-state")).toBe("embed");

    const embed = screen.getByTestId(
      "onboarding-live-map-embed",
    ) as HTMLIFrameElement;
    expect(embed.src).toContain(encodeURIComponent("19.076000,72.877700"));
    expect(embed.src).toContain("output=embed");
    // A backdrop, not a maps app. Panning away from yourself on the one screen
    // whose entire point is that you are here would be a strange affordance.
    expect(embed.className).toContain("pointer-events-none");
  });

  it("keeps the headline honest when there is nothing to draw", () => {
    renderFinale({ mapPoint: null });

    expect(map().getAttribute("data-map-state")).toBe("unavailable");
    // No pin. The old screen drew a pulsing blue dot in the middle of a grid,
    // which is a claim about a place nothing knew.
    expect(map().querySelector("[data-onboarding-map-pulse]")).toBeNull();
    expect(screen.queryByTestId("onboarding-live-map-embed")).toBeNull();
    expect(screen.getByText("Map unavailable")).toBeTruthy();

    // And the headline stops promising a map.
    expect(
      screen.getByRole("heading", { name: "You're all set." }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /on the map/ })).toBeNull();
  });

  it("names Location, not Maps, when Location is the thing that is off", () => {
    renderFinale({
      mapPoint: null,
      locationPermission: {
        state: "denied",
        precise: null,
        background: "foreground-only",
        locationServicesEnabled: true,
      },
    });

    expect(screen.getByText("Location is off")).toBeTruthy();
    expect(screen.queryByText("Map unavailable")).toBeNull();
  });

  it("stays fully usable when no map can be drawn at all", async () => {
    // A Maps outage, or a refused permission, must not strand anyone at the end
    // of setup. Everything this screen exists to do still works.
    const props = renderFinale({ mapPoint: null });

    await waitFor(() =>
      expect(
        screen.getByTestId("one-location-onboarding-invite-code").textContent,
      ).toContain("ABCD-EFGH-JKLM"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    expect(props.onCopyOnboardingCircleCode).toHaveBeenCalledWith(
      "ABCDEFGHJKLM",
    );

    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(props.onShareOnboardingCircleCode).toHaveBeenCalledWith(INVITE);

    fireEvent.click(screen.getByText("Join with a code"));
    expect(screen.getByLabelText("Circle code")).toBeTruthy();

    fireEvent.click(finishButton());
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("One Location onboarding finale — the copy", () => {
  it("says each thing once, and says nothing the layout already shows", async () => {
    renderFinale();

    await waitFor(() =>
      expect(
        screen.getByTestId("one-location-onboarding-invite-code").textContent,
      ).toContain("ABCD-EFGH-JKLM"),
    );

    // What survives: state, the privacy fact, the circle's name, the code, its
    // expiry, the two invite actions, the way in, the way on.
    expect(
      screen.getByRole("heading", { name: "You're on the map." }),
    ).toBeTruthy();
    expect(screen.getByText("Private until you share.")).toBeTruthy();
    expect(screen.getByText("Meena Family")).toBeTruthy();
    expect(screen.getByText("Expires in 72 hours")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Share/ })).toBeTruthy();
    expect(screen.getByText("Join with a code")).toBeTruthy();
    expect(finishButton()).toBeTruthy();

    // What does not, and must not come back. Each of these either restated the
    // layout, explained a screen the person had not reached, or asked a
    // question where an action belonged.
    for (const gone of [
      /show up here once they join/i,
      /Bring your people/i,
      /fresh one any time/i,
      /Someone sent you a code/i,
      /finishes setting up/i,
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("gives the invite code room it can never be denied", async () => {
    renderFinale();

    const code = await screen.findByTestId(
      "one-location-onboarding-invite-code",
    );
    // Twelve characters of fixed-width type with two separators cannot reflow:
    // it either fits or it clips, and a clipped code is useless. The class
    // string is the shared contract; `e2e/one-location-ready-panel.layout.spec.ts`
    // measures what it actually does at 320px.
    expect(code.className).toContain("whitespace-nowrap");
    expect(code.className).toContain("text-[clamp(20px,6vw,28px)]");
    expect(code.className).not.toMatch(/truncate|text-ellipsis|line-clamp/u);
    expect(code.getAttribute("data-ui-truncation")).toBe("forbid");
  });
});
