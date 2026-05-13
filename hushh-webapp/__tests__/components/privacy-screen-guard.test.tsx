import React from "react";
import { describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import { PrivacyScreenGuard } from "@/components/app-ui/privacy-screen-guard";

describe("PrivacyScreenGuard Component - Security & Obfuscation", () => {
  it("renders the sensitive content clearly when the window is active", () => {
    const { getByText } = render(
      <PrivacyScreenGuard>
        <p>SSN: 000-00-0000</p>
      </PrivacyScreenGuard>
    );
    const content = getByText("SSN: 000-00-0000");
    
    // Content is visible and not hidden from screen readers
    expect(content).toBeDefined();
    expect(content.closest("div")?.getAttribute("aria-hidden")).toBe("false");
  });

  it("aggressively blurs the content and renders the security shield on window blur", () => {
    const { container, getByText } = render(
      <PrivacyScreenGuard label="Vault locked">
        <p>Secret Portfolio Data</p>
      </PrivacyScreenGuard>
    );

    // Simulate user Alt-Tabbing away from the browser
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    // Verify the shield text appears
    expect(getByText("Vault locked")).toBeDefined();
    
    // Verify the data wrapper receives the strict CSS blur classes
    const wrapper = getByText("Secret Portfolio Data").closest("div");
    expect(wrapper?.className).toContain("blur-md");
    expect(wrapper?.className).toContain("select-none");
    expect(wrapper?.className).toContain("pointer-events-none");
    
    // Verify it is hidden from assistive technologies while backgrounded
    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
  });

  it("restores visibility when the user returns to the tab", () => {
    const { getByText, queryByText } = render(
      <PrivacyScreenGuard>
        <p>Data</p>
      </PrivacyScreenGuard>
    );

    // Leave tab
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(queryByText("Screen hidden for privacy")).toBeDefined();

    // Return to tab
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(queryByText("Screen hidden for privacy")).toBeNull();
  });
});