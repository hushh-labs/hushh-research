import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DurationWheelPicker } from "@/components/one-location/redesign/duration-wheel-picker";

describe("DurationWheelPicker", () => {
  it("shows the parsed hours/minutes for the incoming value", () => {
    // "1" (60 min) has no exact grid point now that :00 isn't selectable --
    // it sits exactly between 0h45m and 1h15m, and rounds up to 1h15m rather
    // than silently shrinking the requested duration.
    render(<DurationWheelPicker value="1" onChange={vi.fn()} />);

    expect(screen.getByRole("spinbutton", { name: "Hours" })).toHaveAttribute(
      "aria-valuetext",
      "1 hr",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Minutes" }),
    ).toHaveAttribute("aria-valuetext", "15 min");
  });

  it("floors every duration at 15 minutes — :00 is not a selectable minute value", () => {
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

    // Restores the wheel's own snapped position (1h15m), not the raw "1"
    // that was passed in and immediately rounded up to the nearest grid
    // point on mount.
    expect(onChange).toHaveBeenCalledWith("1.25");
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

    expect(screen.getByText("Hours")).toBeInTheDocument();
    expect(screen.getByText("Minutes")).toBeInTheDocument();
  });

  it("never offers :00 as a minute value — the floor is 15 minutes", () => {
    render(<DurationWheelPicker value="1" onChange={vi.fn()} />);

    const minutesWheel = screen.getByRole("spinbutton", { name: "Minutes" });
    expect(minutesWheel).toHaveAttribute("aria-valuemin", "0");
    expect(minutesWheel).toHaveAttribute("aria-valuemax", "2");
    expect(screen.queryByText("00")).not.toBeInTheDocument();
  });
});
