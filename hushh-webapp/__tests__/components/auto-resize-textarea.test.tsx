import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AutoResizeTextarea } from "@/components/app-ui/auto-resize-textarea";

describe("AutoResizeTextarea Component - Chat UX", () => {
  it("renders as a textarea with the correct default minimum height", () => {
    const { getByRole } = render(<AutoResizeTextarea minHeight={50} />);
    const textarea = getByRole("textbox");
    
    expect(textarea).toBeDefined();
    expect(textarea.style.minHeight).toBe("50px");
  });

  it("intercepts the Enter key to trigger onEnterPress but allows Shift+Enter to pass through", () => {
    const onEnterMock = vi.fn();
    const { getByRole } = render(<AutoResizeTextarea onEnterPress={onEnterMock} />);
    const textarea = getByRole("textbox");

    // Press Shift + Enter (Should NOT trigger mock, should add new line)
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onEnterMock).not.toHaveBeenCalled();

    // Press standard Enter (Should trigger mock)
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onEnterMock).toHaveBeenCalledOnce();
  });

  it("includes strict keyboard focus-visible states", () => {
    const { getByRole } = render(<AutoResizeTextarea />);
    const textarea = getByRole("textbox");
    
    expect(textarea.className).toContain("focus-visible:ring-2");
    expect(textarea.className).toContain("focus-visible:outline-none");
    expect(textarea.className).toContain("resize-none"); // Prevents native ugly drag handles
  });
});