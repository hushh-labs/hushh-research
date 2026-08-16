import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DurationWheelPicker } from "@/components/one-location/redesign/duration-wheel-picker";

describe("DurationWheelPicker", () => {
  it("shows the parsed hours/minutes for the incoming value", () => {
    // "1" (60 min) now has an exact grid point -- :00 is selectable once
    // Hours is above zero -- so it resolves exactly, no rounding.
    render(<DurationWheelPicker value="1" onChange={vi.fn()} />);

    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "1 hr",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuetext", "0 min");
  });

  it("floors every duration at 15 minutes when hours would be 0 — 0h0m is not a selectable combination", () => {
    render(<DurationWheelPicker value="0" onChange={vi.fn()} />);

    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "0 hr",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuetext", "15 min");
  });

  it("emits the until-stop alias and disables the wheel while toggled on", () => {
    const onChange = vi.fn();
    render(<DurationWheelPicker value="1" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Until I stop" }));

    expect(onChange).toHaveBeenCalledWith("24");
    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("restores the prior wheel value when until-stop is toggled back off", () => {
    const onChange = vi.fn();
    render(<DurationWheelPicker value="1" onChange={onChange} />);

    const toggle = screen.getByRole("button", { name: "Until I stop" });
    fireEvent.click(toggle);
    onChange.mockClear();
    fireEvent.click(toggle);

    // Restores the wheel's own snapped position (1h00m, an exact grid
    // point now that :00 is selectable) -- same as the raw "1" passed in.
    expect(onChange).toHaveBeenCalledWith("1");
    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });

  it("re-syncs from an external value change (e.g. edit-grant cancel resetting the field)", () => {
    const { rerender } = render(
      <DurationWheelPicker value="1" onChange={vi.fn()} />,
    );

    rerender(<DurationWheelPicker value="4" onChange={vi.fn()} />);

    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "4 hr",
    );
  });

  it("treats the until-stop alias value as already-toggled-on when passed in externally", () => {
    render(<DurationWheelPicker value="24" onChange={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Until I stop" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("labels both columns visibly, not just for screen readers", () => {
    render(<DurationWheelPicker value="1" onChange={vi.fn()} />);

    // Visible unit labels sit inline beside each column (iOS Timer style),
    // not in a header row above the wheel -- the accessible name ("Hours" /
    // "Minutes") stays on each spinbutton's aria-label regardless.
    expect(screen.getByText("hours")).toBeInTheDocument();
    expect(screen.getByText("min")).toBeInTheDocument();
  });

  it("offers :00 as a minute value once Hours is above zero, shown unpadded like Hours", () => {
    render(<DurationWheelPicker value="2" onChange={vi.fn()} />);

    const minutesWheel = screen.getByRole("spinbutton", { name: "Minutes" });
    expect(minutesWheel).toHaveAttribute("aria-valuemin", "0");
    expect(minutesWheel).toHaveAttribute("aria-valuemax", "3");
    expect(minutesWheel).toHaveAttribute("aria-valuetext", "0 min");
    // "0", not "00" -- matches the Hours column's own plain digit style.
    // Scoped to the Minutes wheel: with Hours on 2, its own "0" row (hours
    // 0, still visible a couple rows out) would otherwise collide.
    expect(within(minutesWheel).getByText("0")).toBeInTheDocument();
  });

  it("keeps 0 hours 0 minutes unreachable, snapping Minutes to 15 the instant Hours reaches 0", () => {
    const onChange = vi.fn();
    // "1" resolves exactly to 1h 0m (Minutes starts on "0").
    render(<DurationWheelPicker value="1" onChange={onChange} />);
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuetext", "0 min");

    // Scroll Hours down from 1 to 0 while Minutes is still sitting on "0"
    // -- the forbidden 0h0m combination is reachable this way even though
    // neither wheel alone ever "chose" it.
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Hours" }), {
      key: "ArrowUp",
    });

    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "0 hr",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuetext", "15 min");
    expect(onChange).not.toHaveBeenCalledWith("0");
  });

  it("drops the :00 row from Minutes entirely while Hours is 0", () => {
    // The old build offered :00 at zero hours and then yanked the wheel back
    // to :15 under the person's finger. The constraint is the same; showing
    // it instead of enforcing it invisibly is what stops minutes-first
    // scrolling from bouncing.
    render(<DurationWheelPicker value="0.5" onChange={vi.fn()} />);

    const minutesWheel = screen.getByRole("spinbutton", { name: "Minutes" });
    expect(minutesWheel).toHaveAttribute("aria-valuemax", "2");
    expect(within(minutesWheel).queryByText("0")).toBeNull();
  });

  it("round-trips a literal 24 instead of silently shrinking it to 23h45m", () => {
    // With a caller-supplied sentinel ("until_stopped"), the string "24" is
    // an ordinary duration and must survive. It did not: the grid stopped at
    // 23h45m, so a spoken "share for 24 hours" read back as 23h 45m.
    const onChange = vi.fn();
    render(
      <DurationWheelPicker
        value="24"
        onChange={onChange}
        untilStopValue="until_stopped"
      />,
    );

    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "24 hr",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuetext", "0 min");
    expect(onChange).not.toHaveBeenCalledWith("23.75");
  });

  it("offers only :00 at the 24-hour ceiling, because 24h15m is rejected by the backend", () => {
    render(
      <DurationWheelPicker
        value="24"
        onChange={vi.fn()}
        untilStopValue="until_stopped"
      />,
    );

    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuemax", "0");
  });

  it("renders a 120px viewport in 3-row mode and 200px by default", () => {
    // The compact panel inside the preset ladder. 5 rows is 200px on a
    // screen the founder already called too tall.
    const { unmount } = render(
      <DurationWheelPicker value="1" onChange={vi.fn()} visibleRows={3} />,
    );
    expect(
      screen.getByRole("spinbutton", { name: "Hours" }).style.height,
    ).toBe("120px");
    unmount();

    render(<DurationWheelPicker value="1" onChange={vi.fn()} />);
    expect(
      screen.getByRole("spinbutton", { name: "Hours" }).style.height,
    ).toBe("200px");
  });

  it("removes the until-stop toggle entirely when the caller owns that option", () => {
    const { container } = render(
      <DurationWheelPicker value="1" onChange={vi.fn()} showUntilStop={false} />,
    );

    expect(screen.queryByRole("button", { name: "Until I stop" })).toBeNull();
    // `getByRole` skips hidden elements, so a toggle rendered with `hidden`
    // would pass the query above while still occupying the DOM.
    expect(container.textContent).not.toContain("Until I stop");
    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });

  it("reaches 0 minutes smoothly via keyboard when Hours is above zero (no guard interference)", () => {
    // Regression check: the 0h0m guard must only apply when Hours is
    // exactly 0 -- it must never block Minutes from reaching "0" while
    // Hours is 1 or more.
    render(<DurationWheelPicker value="2.75" onChange={vi.fn()} />);
    const minutesWheel = screen.getByRole("spinbutton", { name: "Minutes" });
    // 2.75h = 2h45m -> Minutes starts on "45", the last item.
    expect(minutesWheel).toHaveAttribute("aria-valuetext", "45 min");

    fireEvent.keyDown(minutesWheel, { key: "ArrowUp" }); // 45 -> 30
    fireEvent.keyDown(minutesWheel, { key: "ArrowUp" }); // 30 -> 15
    fireEvent.keyDown(minutesWheel, { key: "ArrowUp" }); // 15 -> 0
    expect(minutesWheel).toHaveAttribute("aria-valuetext", "0 min");
    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "2 hr",
    );
  });
});
