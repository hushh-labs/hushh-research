// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CHECK_IN_STAR_TARGET_CLASSNAME,
} from "@/components/one-location/nearby-check-in/check-in-panel-layout";
import { StarRatingInput } from "@/components/one-location/nearby-check-in/star-rating-input";

function stars() {
  return screen.getAllByRole("radio");
}

describe("StarRatingInput", () => {
  it("offers five stars named the way a person would say them", () => {
    render(<StarRatingInput value={null} onChange={vi.fn()} />);

    expect(stars()).toHaveLength(5);
    // "1 star", not "1 stars". The singular is the whole reason this is a
    // function rather than a template.
    expect(screen.getByRole("radio", { name: "1 star" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "5 stars" })).toBeInTheDocument();
  });

  it("reports the star that was tapped", () => {
    const onChange = vi.fn();
    render(<StarRatingInput value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "3 stars" }));

    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("fills every star up to the chosen one and none above it", () => {
    const { container } = render(<StarRatingInput value={3} onChange={vi.fn()} />);
    const glyphs = container.querySelectorAll("svg");

    expect(glyphs).toHaveLength(5);
    glyphs.forEach((glyph, index) => {
      expect(glyph.classList.contains("fill-current")).toBe(index < 3);
    });
  });

  it("stops at five instead of wrapping round to one", async () => {
    // A rating that silently becomes a 1 on one extra ArrowRight is a real
    // mis-set, and the control gives no way to notice it happened.
    const onChange = vi.fn();
    render(<StarRatingInput value={5} onChange={onChange} />);

    const fifth = screen.getByRole("radio", { name: "5 stars" });
    fifth.focus();
    fireEvent.keyDown(fifth, { key: "ArrowRight" });

    expect(onChange).not.toHaveBeenCalledWith(1);
  });

  it("gives every star the platform's minimum touch target", () => {
    render(<StarRatingInput value={null} onChange={vi.fn()} />);

    for (const star of stars()) {
      expect(star.className).toContain(CHECK_IN_STAR_TARGET_CLASSNAME);
      // 44px, stated as the class the Playwright contract measures.
      expect(star.className).toContain("h-11");
      expect(star.className).toContain("w-11");
    }
  });

  it("says the adjective out loud, because the radio's own label does not", () => {
    // Radix announces the item on focus, but a VoiceOver double-tap reads only
    // that item's label -- and "Good" is not in it.
    const { rerender } = render(<StarRatingInput value={4} onChange={vi.fn()} />);
    expect(screen.getByText("Good")).toBeInTheDocument();

    rerender(<StarRatingInput value={1} onChange={vi.fn()} />);
    expect(screen.getByText("Poor")).toBeInTheDocument();
  });

  it("shows no adjective before a star is chosen", () => {
    render(<StarRatingInput value={null} onChange={vi.fn()} />);

    expect(screen.queryByText("Good")).toBeNull();
    expect(screen.queryByText("Poor")).toBeNull();
  });

  it("stops accepting input while the rating is being saved", () => {
    render(<StarRatingInput value={4} onChange={vi.fn()} disabled />);

    for (const star of stars()) {
      expect(star).toBeDisabled();
    }
  });
});
