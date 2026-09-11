import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SegmentedControl } from "@/lib/morphy-ux/ui/segmented-control";

/**
 * The mode switch is a radio group, so it has to behave like one.
 *
 * It shipped with no group name, no roving tabindex and no arrow keys, on the
 * surface whose entire product claim is which agent answered: a screen reader
 * heard "One, radio button, 1 of 2" inside an unnamed group and was never told
 * these are two different agents, and a keyboard user who pressed the standard
 * gesture for a radio group got nothing.
 */

function Harness({ initial = "one" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      ariaLabel="Agent"
      value={value}
      onValueChange={setValue}
      options={[
        { value: "one", label: "One", accessibleLabel: "One, your cloud agent" },
        {
          value: "puppy",
          label: "Puppy",
          accessibleLabel: "Puppy One, on your machine",
        },
      ]}
    />
  );
}

describe("SegmentedControl accessibility", () => {
  it("names the group and each agent inside it", () => {
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "Agent" });
    expect(group).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "One, your cloud agent" }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Puppy One, on your machine" }),
    ).not.toBeChecked();
  });

  it("is one tab stop, with the checked segment carrying it", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: /cloud agent/ })).toHaveAttribute(
      "tabindex",
      "0",
    );
    expect(screen.getByRole("radio", { name: /on your machine/ })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("keeps a tab stop when the value matches no option", () => {
    // A stale persisted value would otherwise make every segment tabIndex -1
    // and drop the whole control out of the tab order, which is strictly worse
    // than the two tab stops the roving index replaces.
    render(<Harness initial="neither" />);
    const radios = screen.getAllByRole("radio");
    expect(radios.some((node) => node.getAttribute("tabindex") === "0")).toBe(true);
  });

  it("moves with the arrow keys, and wraps", () => {
    render(<Harness />);
    const one = screen.getByRole("radio", { name: /cloud agent/ });
    const puppy = screen.getByRole("radio", { name: /on your machine/ });

    fireEvent.keyDown(one, { key: "ArrowRight" });
    expect(puppy).toBeChecked();
    expect(puppy).toHaveFocus();

    fireEvent.keyDown(puppy, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: /cloud agent/ })).toBeChecked();

    fireEvent.keyDown(screen.getByRole("radio", { name: /cloud agent/ }), {
      key: "End",
    });
    expect(screen.getByRole("radio", { name: /on your machine/ })).toBeChecked();
  });

  it("leaves browser and OS chords alone", () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        ariaLabel="Agent"
        value="one"
        onValueChange={onValueChange}
        options={[
          { value: "one", label: "One" },
          { value: "puppy", label: "Puppy" },
        ]}
      />,
    );
    fireEvent.keyDown(screen.getByRole("radio", { name: "One" }), {
      key: "ArrowRight",
      metaKey: true,
    });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
