import React from "react";
import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SecureValueMask } from "@/components/app-ui/secure-value-mask";

describe("SecureValueMask Component - Privacy & A11y", () => {
  it("masks the value by default leaving only the tail exposed", () => {
    const { getByText } = render(
      <SecureValueMask value="SuperSecret1234" unmaskedLength={4} />
    );
    expect(getByText("•••••••••••1234")).toBeDefined();
  });

  it("reveals the full value when the toggle is clicked and updates ARIA states", () => {
    const { getByText, getByRole } = render(
      <SecureValueMask value="SecretKey" />
    );
    const button = getByRole("button");

    // Initial State
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Reveal value");

    // Click to Reveal
    fireEvent.click(button);

    expect(getByText("SecretKey")).toBeDefined();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Hide value");
  });

  it("safely handles short values without crashing", () => {
    const { getByText } = render(
      <SecureValueMask value="123" unmaskedLength={4} />
    );
    // If the value is shorter than the unmasked length, it should just display it
    expect(getByText("123")).toBeDefined();
  });

  it("includes strict keyboard focus-visible states on the toggle button", () => {
    const { getByRole } = render(<SecureValueMask value="Test" />);
    const button = getByRole("button");
    expect(button.className).toContain("focus-visible:ring-2");
    expect(button.className).toContain("focus-visible:outline-none");
  });
});