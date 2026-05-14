import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ProgressStepper } from "@/components/app-ui/progress-stepper";

describe("ProgressStepper Component - Navigation & A11y", () => {
  const mockSteps = [
    { id: "identity", title: "Identity", description: "Verify your name" },
    { id: "documents", title: "Documents", description: "Upload ID" },
    { id: "review", title: "Review", description: "Final check" },
  ];

  it("renders a semantic ordered list for screen reader compatibility", () => {
    const { getByRole, getAllByRole } = render(
      <ProgressStepper steps={mockSteps} currentStepIndex={0} />
    );
    
    // Checks for the <ol> and <li> tags
    expect(getByRole("list")).toBeDefined();
    expect(getAllByRole("listitem").length).toBe(3);
  });

  it("applies the strict aria-current='step' attribute only to the active step", () => {
    const { getAllByRole } = render(
      <ProgressStepper steps={mockSteps} currentStepIndex={1} />
    );
    
    const listItems = getAllByRole("listitem");
    
    // Step 0: Complete (no aria-current)
    expect(listItems[0].getAttribute("aria-current")).toBeNull();
    
    // Step 1: Current
    expect(listItems[1].getAttribute("aria-current")).toBe("step");
    
    // Step 2: Upcoming (no aria-current)
    expect(listItems[2].getAttribute("aria-current")).toBeNull();
  });

  it("injects sr-only text so screen readers can announce completion status", () => {
    const { getByText } = render(
      <ProgressStepper steps={mockSteps} currentStepIndex={1} />
    );
    
    expect(getByText("Completed step:")).toBeDefined();
    expect(getByText("Current step:")).toBeDefined();
    expect(getByText("Upcoming step:")).toBeDefined();
  });

  it("returns null safely if provided an empty array of steps", () => {
    const { container } = render(<ProgressStepper steps={[]} currentStepIndex={0} />);
    expect(container.firstChild).toBeNull();
  });
});