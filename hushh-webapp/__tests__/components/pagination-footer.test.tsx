import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PaginationFooter } from "@/components/app-ui/pagination-footer";

describe("PaginationFooter Component - Navigation & A11y", () => {
  it("renders correct page numbers and disables the 'Previous' button on page 1", () => {
    const { getByLabelText, getByText } = render(
      <PaginationFooter currentPage={1} totalPages={5} onPageChange={vi.fn()} />
    );
    
    expect(getByText("1")).toBeDefined();
    expect(getByText("5")).toBeDefined();
    
    const prevButton = getByLabelText("Go to previous page") as HTMLButtonElement;
    expect(prevButton.disabled).toBe(true);
    expect(prevButton.getAttribute("aria-disabled")).toBe("true");
  });

  it("disables the 'Next' button on the last page", () => {
    const { getByLabelText } = render(
      <PaginationFooter currentPage={5} totalPages={5} onPageChange={vi.fn()} />
    );
    
    const nextButton = getByLabelText("Go to next page") as HTMLButtonElement;
    expect(nextButton.disabled).toBe(true);
    expect(nextButton.getAttribute("aria-disabled")).toBe("true");
  });

  it("fires the onPageChange callback with the correct math when navigation is clicked", () => {
    const onPageChangeMock = vi.fn();
    const { getByLabelText } = render(
      <PaginationFooter currentPage={2} totalPages={5} onPageChange={onPageChangeMock} />
    );

    const prevButton = getByLabelText("Go to previous page");
    const nextButton = getByLabelText("Go to next page");

    fireEvent.click(prevButton);
    expect(onPageChangeMock).toHaveBeenCalledWith(1);

    fireEvent.click(nextButton);
    expect(onPageChangeMock).toHaveBeenCalledWith(3);
  });

  it("injects a polite live region to announce page changes to screen readers", () => {
    const { container } = render(
      <PaginationFooter currentPage={3} totalPages={10} itemName="audit logs" onPageChange={vi.fn()} />
    );
    
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeDefined();
    expect(liveRegion?.textContent).toBe("Showing page 3 of 10 for audit logs.");
  });
});