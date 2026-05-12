import React from "react";
import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { FileDropzone } from "@/components/app-ui/file-dropzone";

describe("FileDropzone Component - Layout & A11y", () => {
  it("renders a visually hidden native file input for accessibility", () => {
    const { container } = render(<FileDropzone label="Upload KYC Document" />);
    const input = container.querySelector("input[type='file']");

    expect(input).toBeDefined();
    // Must be hidden visually but remain in the DOM for keyboard focus
    expect(input?.className).toContain("sr-only");
    expect(input?.getAttribute("aria-label")).toBe("Upload KYC Document");
  });

  it("updates styling classes when a file is dragged over the zone", () => {
    const { container } = render(<FileDropzone />);
    const dropzone = container.firstChild as HTMLElement;

    // Trigger drag over
    fireEvent.dragOver(dropzone);
    expect(dropzone.className).toContain("border-primary");
    expect(dropzone.className).toContain("bg-primary/5");

    // Trigger drag leave
    fireEvent.dragLeave(dropzone);
    expect(dropzone.className).not.toContain("border-primary");
  });

  it("forwards the keyboard focus ring to the parent container", () => {
    const { container } = render(<FileDropzone />);
    const dropzone = container.firstChild as HTMLElement;

    expect(dropzone.className).toContain("focus-within:ring-2");
    expect(dropzone.className).toContain("focus-within:ring-ring");
  });
});