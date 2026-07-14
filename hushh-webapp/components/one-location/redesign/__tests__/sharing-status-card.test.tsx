import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SharingStatusCard } from "@/components/one-location/redesign/sharing-status-card";

const baseProps = {
  isSharing: false,
  title: "Private right now",
  subtitle: "No one can see your location.",
  people: [],
  onTapShare: () => {},
};

describe("SharingStatusCard", () => {
  it("OFF badge turns the preview on via onToggle", () => {
    const onToggle = vi.fn();
    const onToggleOff = vi.fn();
    render(
      <SharingStatusCard
        {...baseProps}
        live={false}
        onToggle={onToggle}
        onToggleOff={onToggleOff}
      />,
    );
    const badge = screen.getByRole("button", {
      name: "Turn on live location",
    });
    fireEvent.click(badge);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggleOff).not.toHaveBeenCalled();
  });

  it("LIVE badge is a true toggle: tapping while live calls onToggleOff", () => {
    const onToggle = vi.fn();
    const onToggleOff = vi.fn();
    render(
      <SharingStatusCard
        {...baseProps}
        live
        onToggle={onToggle}
        onToggleOff={onToggleOff}
      />,
    );
    const badge = screen.getByRole("button", {
      name: "Turn off live location preview",
    });
    expect(badge).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(badge);
    expect(onToggleOff).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("without onToggleOff (active share) the LIVE badge falls back to refresh", () => {
    const onToggle = vi.fn();
    render(
      <SharingStatusCard {...baseProps} isSharing live onToggle={onToggle} />,
    );
    const badge = screen.getByRole("button", { name: "Live location on" });
    fireEvent.click(badge);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("card surfaces carry dark-theme variants (no forced light card)", () => {
    const { container } = render(<SharingStatusCard {...baseProps} />);
    const root = container.firstElementChild as HTMLElement;
    // The hero card must not pin dark mode to a white surface.
    expect(root.className).not.toContain("dark:bg-white");
    expect(root.className).toContain("dark:bg-[#1f1f24]");
    // The stylised map backdrop inverts for dark so it cannot glow white.
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class") ?? "").toContain("dark:[filter:");
  });
});
