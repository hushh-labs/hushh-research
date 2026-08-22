// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

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
  it("is the member count and nothing else", () => {
    // `memberCount` includes the viewer, so a circle of one is a circle with
    // nobody else in it yet -- the exact row in the report.
    renderCircles([circle({ memberCount: 1 })]);
    expect(screen.getByText("0 members")).toBeTruthy();
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

  it("still counts everyone but the viewer, and says member once", () => {
    renderCircles([
      circle({ id: "c_two", name: "Two", memberCount: 2 }),
      circle({ id: "c_four", name: "Four", memberCount: 4 }),
    ]);
    expect(screen.getByText("1 member")).toBeTruthy();
    expect(screen.getByText("3 members")).toBeTruthy();
  });
});
