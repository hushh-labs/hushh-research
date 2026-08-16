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

    expect(onChange).toHaveBeenCalledWith("until_stopped");
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
    render(<DurationWheelPicker value="until_stopped" onChange={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Until I stop" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("treats a literal 24 as an ordinary 24-hour duration, not the until-stop alias", () => {
    // "24" used to BE the sentinel; now that a literal 24h0m is reachable
    // on the wheel, it has to resolve as a real duration instead.
    render(<DurationWheelPicker value="24" onChange={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Until I stop" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "24 hr",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuetext", "0 min");
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

  it("keeps 24h45m unreachable, snapping Minutes to 0 the instant Hours reaches 24", () => {
    const onChange = vi.fn();
    render(<DurationWheelPicker value="23.75" onChange={onChange} />);
    // 23.75h = 23h45m -> Minutes starts on "45".
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuetext", "45 min");

    // Scroll Hours up from 23 to 24 while Minutes is still sitting on "45"
    // -- the forbidden 24h45m combination is reachable this way even though
    // neither wheel alone ever "chose" it.
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Hours" }), {
      key: "ArrowDown",
    });

    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "24 hr",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuetext", "0 min");
    expect(onChange).not.toHaveBeenCalledWith("24.75");
    expect(onChange).not.toHaveBeenCalledWith("24.25");
    expect(onChange).not.toHaveBeenCalledWith("24.5");
  });

  it("locks Minutes to 0 while Hours sits at the 24 ceiling", () => {
    render(<DurationWheelPicker value="24" onChange={vi.fn()} />);
    expect(
      screen.getByRole("spinbutton", { name: "Hours" }),
    ).toHaveAttribute("aria-valuemax", "24");
    const minutesWheel = screen.getByRole("spinbutton", { name: "Minutes" });
    expect(minutesWheel).toHaveAttribute("aria-valuetext", "0 min");

    // Any attempt to move Minutes off 0 while Hours is still 24 snaps
    // straight back -- mirrors Minutes refusing to sit on 0 while Hours is 0.
    fireEvent.keyDown(minutesWheel, { key: "ArrowDown" });
    expect(minutesWheel).toHaveAttribute("aria-valuetext", "0 min");
    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "24 hr",
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
