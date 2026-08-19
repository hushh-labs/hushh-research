/**
 * The owner reviewing an incoming location request could only Approve the
 * exact amount asked for, or Decline — there was no way to grant a
 * different duration. RequestCard now renders a compact duration picker
 * (seeded to the exact amount asked for) above Approve/Decline whenever the
 * request names a timed duration, and only passes an override to `onApprove`
 * once the owner actually changes it — an untouched picker still grants
 * exactly what was requested, through the same call shape as before.
 *
 * DurationSelector renders a Radix Select, which is awkward to drive in
 * jsdom — stood in here with a plain native <select> so these tests exercise
 * RequestCard's own logic (seed, live label, when an override is sent) and
 * not Radix's internals.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/one-location/redesign/selectors", () => ({
  DurationSelector: ({
    value,
    onChange,
    options,
    label,
  }: {
    value: string;
    onChange: (next: string) => void;
    options: { value: string; label: string }[];
    label?: string;
  }) => (
    <select
      aria-label={label || "Duration"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { RequestCard } from "@/components/one-location/redesign/cards";

const DURATION_OPTIONS = [
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "3", label: "3 hours" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

describe("RequestCard — approval duration override", () => {
  it("renders no picker for an 'until I stop' ask, and approves with no override", () => {
    const onApprove = vi.fn();
    render(
      <RequestCard
        name="Abdul Rashid"
        promptLine="Asks to see your location until you stop"
        approveLabel="Approve until you stop"
        onApprove={onApprove}
        onDecline={vi.fn()}
      />,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve until you stop" }));
    expect(onApprove).toHaveBeenCalledWith(undefined);
  });

  it("approves with no override when the picker is left untouched", () => {
    const onApprove = vi.fn();
    render(
      <RequestCard
        name="Abdul Rashid"
        promptLine="Asks to see your location for 3 hours"
        approveLabel="Approve 3 hours"
        onApprove={onApprove}
        onDecline={vi.fn()}
        durationOptions={DURATION_OPTIONS}
        durationSeed="3"
      />,
    );

    const select = screen.getByRole("combobox", { name: "Share for" });
    expect(select).toHaveValue("3");
    expect(
      screen.getByRole("button", { name: "Approve 3 hours" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve 3 hours" }));
    // Untouched: no override sent, so the caller's own "grant exactly what
    // was requested" default path runs — not a redundant 3 passed back.
    expect(onApprove).toHaveBeenCalledWith(undefined);
  });

  it("updates the button label live and approves with the new amount once changed", () => {
    const onApprove = vi.fn();
    render(
      <RequestCard
        name="Abdul Rashid"
        promptLine="Asks to see your location for 3 hours"
        approveLabel="Approve 3 hours"
        onApprove={onApprove}
        onDecline={vi.fn()}
        durationOptions={DURATION_OPTIONS}
        durationSeed="3"
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Share for" }), {
      target: { value: "1" },
    });

    expect(
      screen.getByRole("button", { name: "Approve 1 hour" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve 1 hour" }));
    expect(onApprove).toHaveBeenCalledWith(1);
  });

  it("reverting the picker back to the seed drops the override again", () => {
    const onApprove = vi.fn();
    render(
      <RequestCard
        name="Abdul Rashid"
        promptLine="Asks to see your location for 3 hours"
        approveLabel="Approve 3 hours"
        onApprove={onApprove}
        onDecline={vi.fn()}
        durationOptions={DURATION_OPTIONS}
        durationSeed="3"
      />,
    );

    const select = screen.getByRole("combobox", { name: "Share for" });
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.change(select, { target: { value: "3" } });

    expect(
      screen.getByRole("button", { name: "Approve 3 hours" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve 3 hours" }));
    expect(onApprove).toHaveBeenCalledWith(undefined);
  });

  it("declining still works, and a second tap after deciding is a no-op", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(
      <RequestCard
        name="Abdul Rashid"
        promptLine="Asks to see your location for 3 hours"
        approveLabel="Approve 3 hours"
        onApprove={onApprove}
        onDecline={onDecline}
        durationOptions={DURATION_OPTIONS}
        durationSeed="3"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Declined")).toBeInTheDocument();
    // The picker and buttons are gone once decided — nothing left to
    // double-tap, but assert there is exactly one decline call all the same.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
  });
});
