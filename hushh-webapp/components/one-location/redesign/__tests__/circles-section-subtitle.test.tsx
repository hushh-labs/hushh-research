// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";

import { describe, expect, it, vi } from "vitest";

import { CirclesSection } from "@/components/one-location/redesign/circles/named-circle-flows";
import type { OneLocationCircleSummary } from "@/lib/one-location/types";

/**
 * What the "Your circles" row says under a circle's name.
 *
 * Reported from QA, on a circle the app itself created during onboarding:
 * "onboarding ke time hi yeh Jhumma's circle create hua tha, jisme neeche
 * Family 0 members dekha rha. category 3 hain family friends other, toh yahan
 * family hi kyu. simply say 0 member instead."
 *
 * The row led with a category the person was never asked to choose -- the
 * onboarding circle is filed under `family` by default -- and put it ahead of
 * the only fact on the line that was actually true.
 */

const noop = vi.fn();

function circle(
  overrides: Partial<OneLocationCircleSummary> = {},
): OneLocationCircleSummary {
  return {
    id: "circle_jhumma",
    name: "JHUMMA's Circle",
    kind: "family",
    role: "owner",
    memberCount: 1,
    memberLimit: 20,
    ...overrides,
  } as OneLocationCircleSummary;
}

function renderCircles(circles: OneLocationCircleSummary[]) {
  return render(
    <CirclesSection
      circles={circles}
      incomingInvites={[]}
      incomingInvitesLoading={false}
      incomingInvitesError={null}
      focusedInviteId={null}
      focusedInviteResolutionReady
      inviteBusy={false}
      onCreate={noop}
      onJoin={noop}
      onOpen={noop}
      onAcceptInvite={vi.fn().mockResolvedValue(undefined)}
      onDeclineInvite={vi.fn().mockResolvedValue(undefined)}
      onRetryInvites={noop}
      onDismissFocusedInvite={noop}
    />,
  );
}

describe("the circle row's second line", () => {
  it("says Only you when nobody else is in the Circle", () => {
    // `memberCount` includes the viewer, so a circle of one is a circle with
    // nobody else in it yet -- the exact row in the report.
    renderCircles([circle({ memberCount: 1 })]);
    expect(screen.getByText("Only you")).toBeTruthy();
  });

  it("never names the category the person did not choose", () => {
    // The three kinds all reached this line the same way. None of them belong
    // on it, so none of them is allowed back by fixing only the default.
    renderCircles([
      circle({ id: "c_family", name: "A", kind: "family" }),
      circle({ id: "c_friends", name: "B", kind: "friends" }),
      circle({ id: "c_other", name: "C", kind: "other" }),
    ]);
    for (const word of ["Family", "Friends", "Other"]) {
      expect(screen.queryByText(new RegExp(`${word}\\s*·`))).toBeNull();
    }
  });

  it("still counts everyone but the viewer, and says person once", () => {
    renderCircles([
      circle({ id: "c_two", name: "Two", memberCount: 2 }),
      circle({ id: "c_four", name: "Four", memberCount: 4 }),
    ]);
    expect(screen.getByText("1 person")).toBeTruthy();
    expect(screen.getByText("3 people")).toBeTruthy();
  });

  it("uses the red SMS identity for the Save My Soul system Circle", () => {
    renderCircles([
      circle({
        id: "c_sms",
        name: "SMS Circle",
        memberCount: 2,
        isSystem: true,
        systemKind: "sms",
      }),
    ]);

    expect(screen.getByText("SMS")).toBeTruthy();
    expect(screen.getByText("Save My Soul · 1 person")).toBeTruthy();
    expect(screen.queryByTestId("siren")).toBeNull();

    // 36px here, because these rows are 60px tall with their own padding
    // overrides; Connect's Circles tab draws the same red disc at 28px to sit
    // in its compact icon well. Connect used to draw a `Siren` in the indigo
    // well instead, so the same Circle looked like two different things.
    const mark = screen.getByTestId("one-location-circle-sms-mark");
    expect(mark.className).toContain("bg-[color:var(--app-destructive)]");
    expect(mark.className).toContain("rounded-full");
    expect(mark.className).toContain("h-9");
    expect(mark.className).toContain("w-9");
  });

  it("uses a neutral identity for ordinary Circles", () => {
    renderCircles([
      circle({ id: "c_neutral", name: "Trusted", systemKind: "trusted" }),
    ]);
    expect(screen.getByTestId("one-location-circle-neutral-mark")).toBeTruthy();
  });

  it("separates circles created by you, joined circles, and built-in circles", () => {
    renderCircles([
      circle({ id: "joined_1", name: "Road Trip", role: "member" }),
      circle({ id: "owned_1", name: "Family", role: "owner" }),
      circle({
        id: "built_in_trusted",
        name: "Trusted",
        role: "owner",
        systemKind: "trusted",
      }),
      circle({ id: "owned_2", name: "Close Friends", role: "owner" }),
      circle({
        id: "built_in_sms",
        name: "Emergency Circle",
        role: "owner",
        isSystem: true,
        systemKind: "sms",
      }),
    ]);

    const created = screen.getByTestId("one-location-circle-group-created");
    const joined = screen.getByTestId("one-location-circle-group-joined");
    const builtIn = screen.getByTestId("one-location-circle-group-built-in");

    expect(within(created).getByText("Created by you")).toBeTruthy();
    expect(within(created).getByText("Family")).toBeTruthy();
    expect(within(created).getByText("Close Friends")).toBeTruthy();
    expect(within(created).queryByText("Road Trip")).toBeNull();

    expect(within(joined).getByText("Joined circles")).toBeTruthy();
    expect(within(joined).getByText("Road Trip")).toBeTruthy();
    expect(within(joined).queryByText("Family")).toBeNull();

    expect(within(builtIn).getByText("Built-in")).toBeTruthy();
    expect(within(builtIn).getByText("Trusted")).toBeTruthy();
    expect(within(builtIn).getByText("Emergency Circle")).toBeTruthy();
    expect(within(builtIn).getByText("Save My Soul · Only you")).toBeTruthy();
  });
});
