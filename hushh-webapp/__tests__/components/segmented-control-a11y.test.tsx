import { useState, type SVGProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SegmentedControl } from "@/lib/morphy-ux/ui/segmented-control";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { SegmentedPill } from "@/lib/morphy-ux/ui/segmented-pill";
import { Switch } from "@/components/ui/switch";
const feedback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/capacitor/app-haptics", () => ({ appHaptic: feedback }));

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
  it.each([SegmentedControl, SegmentedTabs, SegmentedPill])("emits only changed authored selections, with an explicit caller-owned opt-out", Component => {
    feedback.mockClear();
    const onValueChange = vi.fn();
    const options = [{ value: "one", label: "One" }, { value: "puppy", label: "Puppy" }];
    const view = render(<Component ariaLabel="Agent" value="one" options={options} onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole(Component === SegmentedTabs ? "tab" : "radio", { name: "One" }));
    expect(feedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole(Component === SegmentedTabs ? "tab" : "radio", { name: "Puppy" }));
    expect(feedback).toHaveBeenCalledExactlyOnceWith("selection");
    view.rerender(<Component ariaLabel="Agent" value="one" options={options} onValueChange={onValueChange} hapticFeedback={false} />);
    fireEvent.click(screen.getByRole(Component === SegmentedTabs ? "tab" : "radio", { name: "Puppy" }));
    expect(feedback).toHaveBeenCalledTimes(1);
  });

  it("preserves uncontrolled Switch state without cues on disabled or repeated controlled values", () => {
    feedback.mockClear();
    const view = render(<Switch aria-label="Preference" defaultChecked={false} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toBeChecked();
    expect(feedback).toHaveBeenCalledExactlyOnceWith("selection");
    view.rerender(<Switch aria-label="Preference" checked disabled />);
    fireEvent.click(screen.getByRole("switch"));
    expect(feedback).toHaveBeenCalledTimes(1);
    view.rerender(<Switch aria-label="Preference" checked={false} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(feedback).toHaveBeenCalledTimes(1);
  });
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

  it("does not paint a false sliding selection or dispatch a disabled choice", () => {
    const onValueChange = vi.fn();
    const options = [{ value: "one", label: "One" }, { value: "puppy", label: "Puppy" }];
    const view = render(<SegmentedControl ariaLabel="Agent" variant="sliding" value="missing"
      options={options} onValueChange={onValueChange} />);
    expect(view.container.querySelector('[data-slot="segmented-selection"]')).toBeNull();
    expect(screen.getAllByRole("radio").every(radio => radio.getAttribute("aria-checked") === "false")).toBe(true);
    view.rerender(<SegmentedControl ariaLabel="Agent" variant="sliding" value="one"
      options={options} onValueChange={onValueChange} disabled />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
      expect(radio).toHaveAttribute("tabindex", "-1");
      fireEvent.click(radio);
      fireEvent.keyDown(radio, { key: "ArrowRight" });
    }
    expect(onValueChange).not.toHaveBeenCalled();
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

  it("can go icon-only at a breakpoint and still name every segment", () => {
    // The chat header's phone variant: the visible word is hidden, the icon
    // shown, and the spoken name must survive both.
    const Glyph = (props: SVGProps<SVGSVGElement>) => <svg {...props} />;
    render(
      <SegmentedControl
        ariaLabel="Agent"
        value="one"
        onValueChange={() => {}}
        iconClassName="sm:hidden"
        labelClassName="max-sm:hidden"
        options={[
          { value: "one", label: "One", icon: Glyph, accessibleLabel: "One, your cloud agent" },
          { value: "puppy", label: "Puppy", icon: Glyph, accessibleLabel: "Puppy One, on your machine" },
        ]}
      />,
    );
    const one = screen.getByRole("radio", { name: "One, your cloud agent" });
    expect(one.querySelector("svg")).toHaveClass("sm:hidden");
    expect(one.querySelector("svg")).toHaveAttribute("aria-hidden");
    expect(screen.getByText("One")).toHaveClass("max-sm:hidden");
    expect(screen.getByRole("radio", { name: "Puppy One, on your machine" })).not.toBeChecked();
  });
});
