import React from "react";
import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ExpandableText } from "@/components/app-ui/expandable-text";

describe("ExpandableText Component - Layout & A11y", () => {
  const shortText = "This is a short string.";
  const longText = "This is a very long string that should definitely be truncated because it exceeds the maximum length threshold set by the component props, ensuring our layout stays pristine.";

  it("does not render a toggle button if the text is under the maxLength limit", () => {
    const { queryByRole } = render(<ExpandableText text={shortText} maxLength={100} />);
    expect(queryByRole("button")).toBeNull();
  });

  it("truncates long text and renders the 'Read more' toggle button", () => {
    const { getByRole, getByText } = render(<ExpandableText text={longText} maxLength={40} />);
    
    // Should show truncated version
    expect(getByText(/This is a very long string that should/)).toBeDefined();
    
    const button = getByRole("button");
    expect(button.textContent?.trim()).toBe("Read more");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands the text fully and updates ARIA states when clicked", () => {
    const { getByRole, getByText } = render(<ExpandableText text={longText} maxLength={40} />);
    const button = getByRole("button");

    fireEvent.click(button);

    // Should show full text
    expect(getByText(longText)).toBeDefined();
    
    // Button state should update
    expect(button.textContent?.trim()).toBe("Show less");
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });
});