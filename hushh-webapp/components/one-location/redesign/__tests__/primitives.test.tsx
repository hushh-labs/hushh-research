// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EmptyState } from "@/components/one-location/redesign/primitives";
import { LocationTypeSelector } from "@/components/one-location/redesign/selectors";

describe("EmptyState", () => {
  it("renders an action node when provided", () => {
    render(
      <EmptyState
        title="Build your trusted circle"
        description="Add connections so the people you trust can receive your live location."
        action={<a href="/one/connect">Add connections</a>}
      />,
    );
    expect(screen.getByText("Build your trusted circle")).toBeTruthy();
    const link = screen.getByText("Add connections").closest("a");
    expect(link?.getAttribute("href")).toBe("/one/connect");
  });
});

describe("LocationTypeSelector", () => {
  it("explains and selects the genuine approximate-area mode", () => {
    const onChange = vi.fn();
    render(<LocationTypeSelector value="precise" onChange={onChange} />);

    expect(screen.getByText(/broad 1 km\+ area/i)).toBeTruthy();
    expect(screen.getByText(/exact moving pin/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /area updates/i }));
    expect(onChange).toHaveBeenCalledWith("approximate");
  });
});
