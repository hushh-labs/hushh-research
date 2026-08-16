import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DurationPresetPicker,
  compactDurationLabel,
} from "@/components/one-location/redesign/duration-presets";

/** Every cell that currently reads as chosen. */
function pressedLabels(): string[] {
  return screen
    .getAllByRole("button")
    .filter((node) => node.getAttribute("aria-pressed") === "true")
    .map((node) => node.textContent ?? "");
}

describe("DurationPresetPicker", () => {
  it("opens on the incoming value with exactly one cell pressed", () => {
    render(<DurationPresetPicker value="0.25" onChange={vi.fn()} />);

    expect(pressedLabels()).toEqual(["15 min"]);
  });

  it("sets exactly one hour in one tap — no rounding to 1h15m", () => {
    // The founder's literal report: "when choosing hours, people are unable
    // to choose 1 hor, 2 hours". On the wheel that was true (its minutes
    // grid had no :00), and even once :00 landed it took two coordinated
    // drags. Here it is one tap and the emitted value is exact.
    const onChange = vi.fn();
    render(<DurationPresetPicker value="0.25" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));

    expect(onChange).toHaveBeenCalledWith("1");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("sets exactly two hours in one tap", () => {
    const onChange = vi.fn();
    render(<DurationPresetPicker value="0.25" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "2 hours" }));

    expect(onChange).toHaveBeenCalledWith("2");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("emits the caller's open-ended sentinel, not the wheel's own alias", () => {
    // The Share screen's sentinel is "until_stopped"; the wheel's default is
    // "24". Nothing pinned the hand-off in either direction before, and the
    // Request screen was silently getting "24" because it never passed one.
    const onChange = vi.fn();
    render(
      <DurationPresetPicker
        value="0.25"
        onChange={onChange}
        untilStopValue="until_stopped"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Until I stop" }));

    expect(onChange).toHaveBeenCalledWith("until_stopped");
  });

  it("does not mount the wheel until Custom is tapped", () => {
    // The whole saving. A wheel that renders anyway costs its 120px whether
    // or not anybody wanted it.
    render(<DurationPresetPicker value="1" onChange={vi.fn()} />);

    expect(screen.queryByRole("spinbutton", { name: "Hours" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Minutes" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));

    expect(screen.getByRole("spinbutton", { name: "Hours" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Minutes" })).toBeTruthy();
  });

  it("hides the open-ended rung when the caller cannot accept it", () => {
    // The Request screen. Its `durationHours` state is shared with the
    // public-link and circle-invite lanes, which do Number(value) on it, so
    // a non-numeric sentinel there posts NaN to a `gt=0` field.
    const { container } = render(
      <DurationPresetPicker value="1" onChange={vi.fn()} allowUntilStop={false} />,
    );

    expect(screen.queryByRole("button", { name: "Until I stop" })).toBeNull();
    // Belt and braces: `getByRole` skips hidden elements, so a rung rendered
    // with `hidden` would pass the query above while still being in the DOM.
    expect(container.textContent).not.toContain("Until I stop");
  });

  it("labels the Custom cell with a real off-grid duration rather than rounding it away", () => {
    // A value that arrives from voice, or from editing a live grant, must be
    // shown as itself. Snapping the label to the nearest rung would tell
    // someone they picked 4 hours when the share runs 2h45m.
    render(<DurationPresetPicker value="2.75" onChange={vi.fn()} />);

    expect(pressedLabels()).toEqual(["2h 45m"]);
  });

  it("seeds Custom with a real number when it is opened from the open-ended rung", () => {
    // The wheel has no row for "until_stopped". Handing it that string makes
    // it parse NaN and floor to 15 minutes — silently shrinking an
    // open-ended share to the minimum the moment Custom is opened.
    const onChange = vi.fn();
    render(
      <DurationPresetPicker
        value="until_stopped"
        onChange={onChange}
        untilStopValue="until_stopped"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));

    expect(onChange).toHaveBeenCalledWith("1");
    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "1 hr",
    );
  });

  it("gives every cell a 44px minimum tap target", () => {
    // jsdom performs no layout, so this is a class contract; the pixels are
    // proven in e2e/one-location-duration-ladder.layout.spec.ts. `h-9` (36px)
    // is what the surrounding chips use and what this must never become.
    render(<DurationPresetPicker value="1" onChange={vi.fn()} />);

    const cells = screen.getAllByRole("button");
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.className).toContain("min-h-11");
      expect(cell.className).not.toContain("h-9");
    }
  });

  it("keeps the whole ladder on one screen: six cells plus the open-ended row", () => {
    render(<DurationPresetPicker value="1" onChange={vi.fn()} />);

    expect(
      screen.getAllByRole("button").map((node) => node.textContent),
    ).toEqual([
      "15 min",
      "1 hour",
      "2 hours",
      "4 hours",
      "8 hours",
      "Custom",
      "Until I stop",
    ]);
  });
});

describe("compactDurationLabel", () => {
  it("stays within six glyphs so it fits an 80px cell at 320px", () => {
    expect(compactDurationLabel("0.25")).toBe("15m");
    expect(compactDurationLabel("1")).toBe("1h");
    expect(compactDurationLabel("2.75")).toBe("2h 45m");
    expect(compactDurationLabel("23.75")).toBe("23h 45m");
  });

  it("falls back to Custom for anything that is not a positive number", () => {
    expect(compactDurationLabel("until_stopped")).toBe("Custom");
    expect(compactDurationLabel("today")).toBe("Custom");
    expect(compactDurationLabel("0")).toBe("Custom");
  });
});
