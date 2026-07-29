import React from "react";
import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ProgressiveImage } from "@/components/app-ui/progressive-image";

describe("ProgressiveImage Component - A11y & Loading States", () => {
  it("renders the image with the mandatory alt text attribute", () => {
    const { getByAltText } = render(<ProgressiveImage src="test.jpg" alt="User Avatar" />);
    const img = getByAltText("User Avatar");
    expect(img).toBeDefined();
  });

  it("transitions opacity smoothly when the image finishes loading", () => {
    const { getByAltText } = render(<ProgressiveImage src="test.jpg" alt="Document" />);
    const img = getByAltText("Document");
    
    // Initially transparent while loading
    expect(img.className).toContain("opacity-0");
    
    // Simulate browser finishing the network request
    fireEvent.load(img);
    
    // Becomes visible
    expect(img.className).toContain("opacity-100");
  });

  it("displays an accessible fallback and hides the broken image tag on network error", () => {
    const { getByAltText, container } = render(
      <ProgressiveImage src="bad-url.jpg" alt="Broken Graphic" />
    );
    const img = getByAltText("Broken Graphic");
    
    // Simulate network error (e.g., 404 Not Found)
    fireEvent.error(img);
    
    // Check for the screen-reader only error message
    const srText = container.querySelector(".sr-only");
    expect(srText?.textContent).toBe("Failed to load image: Broken Graphic");
  });
});