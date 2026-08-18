import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TemporaryLinkCard } from "@/components/one-location/redesign/cards";

/**
 * The Public Links surface shipped with three action buttons that disagreed on
 * height, radius, padding and icon spacing: two carried an icon and one did
 * not, and each restated geometry the `sm` size variant already owns. This
 * locks the group to one geometry so a future edit cannot reintroduce the drift
 * one button at a time.
 */
describe("Public Links action group", () => {
  const renderCard = () =>
    render(
      <TemporaryLinkCard
        title="Public location link active"
        statusLine="Anyone with this link can view you"
        expiryLabel="Expires in 30 min"
        onCopy={vi.fn()}
        onShare={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

  it("gives Copy, Share and Revoke a single geometry", () => {
    renderCard();

    const actions = ["Copy", "Share", "Revoke"].map((name) =>
      screen.getByRole("button", { name }),
    );
    expect(actions).toHaveLength(3);

    for (const action of actions) {
      // Height, horizontal padding and label size come from the size variant,
      // never from a per-button override that can drift from its neighbours.
      expect(action.className).toContain("min-h-9");
      expect(action.className).toContain("px-3");
      expect(action.className).not.toContain("text-sm");
      // The one geometry the group states for itself: the pill radius shared by
      // every compact action on this surface.
      expect(action.className).toContain("rounded-full");
    }
  });

  it("keeps every cell in the group the same shape", () => {
    renderCard();

    // Equal grid columns only read as symmetric when no cell carries an icon
    // its neighbours lack, which is what made "Revoke" sit short of Copy/Share.
    for (const name of ["Copy", "Share", "Revoke"]) {
      expect(
        screen.getByRole("button", { name }).querySelector("svg"),
      ).toBeNull();
    }

    const group = screen.getByRole("button", { name: "Copy" }).parentElement;
    expect(group?.className).toContain("grid-cols-3");
    expect(group?.className).toContain("gap-2");
  });
});
