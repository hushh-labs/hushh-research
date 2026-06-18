import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CopySnippet } from "@/components/app-ui/copy-snippet";

const mockWriteText = vi.fn().mockImplementation(() => Promise.resolve());
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

describe("CopySnippet Component - Utilities & A11y", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWriteText.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders the text normally if isSecret is false", () => {
    const { getByText } = render(<CopySnippet value="Hushh_API_123" label="API Key" />);
    expect(getByText("Hushh_API_123")).toBeDefined();
  });

  it("obfuscates the text by default if isSecret is true and allows toggling", () => {
    const { getByText, getByLabelText, queryByText } = render(
      <CopySnippet value="Hushh_Vault_9999" isSecret={true} />
    );
    expect(getByText("••••••••••••9999")).toBeDefined();
    expect(queryByText("Hushh_Vault_9999")).toBeNull();

    const revealBtn = getByLabelText("Reveal secret value");
    fireEvent.click(revealBtn);
    expect(getByText("Hushh_Vault_9999")).toBeDefined();
  });

  it("copies to clipboard, updates the UI state, and resets after the timeout", async () => {
    const { getByLabelText, container } = render(<CopySnippet value="ToCopy" label="Vault Key" timeoutMs={1000} />);
    const copyBtn = getByLabelText("Vault Key");
    const liveRegion = container.querySelector('[aria-live="polite"]');

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(mockWriteText).toHaveBeenCalledWith("ToCopy");
    expect(liveRegion?.textContent).toContain("Successfully copied");
    expect(copyBtn.getAttribute("aria-label")).toBe("Copied!");

    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(liveRegion?.textContent).toBe("");
    expect(copyBtn.getAttribute("aria-label")).toBe("Vault Key");
  });
});