import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("renders with data-slot=switch", () => {
    const { container } = render(<Switch />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("switch");
  });

  it("renders with default size data attribute", () => {
    const { container } = render(<Switch />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-size")).toBe("default");
  });

  it("renders with sm size data attribute", () => {
    const { container } = render(<Switch size="sm" />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-size")).toBe("sm");
  });

  it("applies custom className", () => {
    const { container } = render(<Switch className="custom-switch-class" />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("class")).toContain("custom-switch-class");
  });

  it("calls onCheckedChange when clicked", () => {
    const handleChange = vi.fn();
    render(<Switch onCheckedChange={handleChange} />);
    const button = screen.getByRole("switch");

    fireEvent.click(button);
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it("renders disabled attribute when disabled prop is true", () => {
    render(<Switch disabled />);
    const button = screen.getByRole("switch");
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});
