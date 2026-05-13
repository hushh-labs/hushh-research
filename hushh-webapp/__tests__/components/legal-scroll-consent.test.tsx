import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { LegalScrollConsent } from "@/components/app-ui/legal-scroll-consent";

describe("LegalScrollConsent Component - Compliance & A11y", () => {
  it("renders the children content and is keyboard focusable", () => {
    const { getByText, getByLabelText } = render(
      <LegalScrollConsent onReadComplete={vi.fn()}>
        <p>Highly sensitive legal text.</p>
      </LegalScrollConsent>
    );
    
    expect(getByText("Highly sensitive legal text.")).toBeDefined();
    
    const container = getByLabelText("Legal terms and conditions document");
    // tabIndex=0 is absolutely critical so keyboard users can focus and press Down Arrow
    expect(container.getAttribute("tabindex")).toBe("0"); 
  });

  it("fires onReadComplete when the user scrolls to the bottom", () => {
    const onReadCompleteMock = vi.fn();
    const { getByLabelText } = render(
      <LegalScrollConsent onReadComplete={onReadCompleteMock}>
        <div style={{ height: "1000px" }}>Long content</div>
      </LegalScrollConsent>
    );

    const container = getByLabelText("Legal terms and conditions document");

    // Mock the DOM geometry properties that JSDOM lacks by default
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    
    // Simulate scrolling halfway down
    Object.defineProperty(container, "scrollTop", { configurable: true, value: 300 });
    fireEvent.scroll(container);
    expect(onReadCompleteMock).not.toHaveBeenCalled();

    // Simulate scrolling to the bottom (1000 - 400 = 600)
    Object.defineProperty(container, "scrollTop", { configurable: true, value: 600 });
    fireEvent.scroll(container);
    expect(onReadCompleteMock).toHaveBeenCalledOnce();
  });

  it("instantly fires onReadComplete if the content is smaller than the container box", () => {
    const onReadCompleteMock = vi.fn();
    const { getByLabelText } = render(
      <LegalScrollConsent onReadComplete={onReadCompleteMock}>
        <div>Very short terms</div>
      </LegalScrollConsent>
    );

    const container = getByLabelText("Legal terms and conditions document");

    // Mock DOM geometry where content is smaller than the viewing window
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 200 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    
    // The initial useEffect should evaluate this and auto-complete
    expect(onReadCompleteMock).toHaveBeenCalledOnce();
  });
});