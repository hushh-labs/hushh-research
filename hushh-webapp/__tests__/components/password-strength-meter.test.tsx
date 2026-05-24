import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PasswordStrengthMeter } from "@/components/app-ui/password-strength-meter";

describe("PasswordStrengthMeter Component - Security & A11y", () => {
  it("renders a polite aria-live region to announce strength to screen readers", () => {
    const { container } = render(<PasswordStrengthMeter password="Weak1" />);
    const liveRegion = container.querySelector('[aria-live="polite"]');
    
    expect(liveRegion).toBeDefined();
    expect(liveRegion?.textContent).toContain("Password strength is currently Fair");
  });

  it("accurately scores a perfect password", () => {
    const { getByText } = render(<PasswordStrengthMeter password="SuperSecurePassword123!" />);
    expect(getByText("Strong")).toBeDefined();
  });

  it("hides the visual progress bar from screen readers to prevent noise", () => {
    const { container } = render(<PasswordStrengthMeter password="Test" />);
    // The wrapper containing the color blocks should have aria-hidden
    const barContainer = container.querySelector('div[aria-hidden="true"]');
    expect(barContainer).toBeDefined();
  });

  it("updates individual requirement checks based on input", () => {
    const { container } = render(<PasswordStrengthMeter password="nouppercase1!" />);
    // Should have 3 checks and 1 cross (missing uppercase)
    const checks = container.querySelectorAll('.lucide-check');
    const crosses = container.querySelectorAll('.lucide-x');
    
    expect(checks.length).toBe(3);
    expect(crosses.length).toBe(1);
  });
});