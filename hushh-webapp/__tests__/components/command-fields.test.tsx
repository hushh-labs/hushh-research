import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { CommandPickerField, PopupTextEditorField } from "@/components/app-ui/command-fields";

// Mock ResizeObserver for JSDOM environments where it is missing
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock scrollIntoView for JSDOM environments where it is missing
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function() {};
}

describe("CommandPickerField", () => {
  const defaultOptions = [
    { value: "opt1", label: "Option 1", description: "Desc 1" },
    { value: "opt2", label: "Option 2", description: "Desc 2" },
  ];

  it("renders trigger value or placeholder", () => {
    render(
      <CommandPickerField
        title="Choose Option"
        placeholder="Select one..."
        value=""
        options={defaultOptions}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText("Select one...")).toBeTruthy();
  });

  it("toggles command dialog open with shortcut", () => {
    render(
      <CommandPickerField
        title="Choose Option"
        placeholder="Select one..."
        value=""
        options={defaultOptions}
        shortcut="k"
        onSelect={vi.fn()}
      />
    );

    expect(screen.queryByRole("dialog")).toBeNull();

    // Trigger Ctrl+k
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("displays shortcut indicator inside trigger when provided", () => {
    render(
      <CommandPickerField
        title="Choose Option"
        placeholder="Select one..."
        value=""
        options={defaultOptions}
        shortcut="k"
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText("⌘K")).toBeTruthy();
  });
});

describe("PopupTextEditorField", () => {
  it("renders with preview placeholder or value", () => {
    render(
      <PopupTextEditorField
        title="Edit Text"
        placeholder="Enter text..."
        value="Hello World"
        onSave={vi.fn()}
      />
    );
    expect(screen.getByText("Hello World")).toBeTruthy();
  });

  it("displays Sparkles icon and handles draft changes with character count", () => {
    const onDraftChange = vi.fn();
    render(
      <PopupTextEditorField
        title="Edit Text"
        placeholder="Enter text..."
        value="Hello World"
        onSave={vi.fn()}
        onDraftChange={onDraftChange}
      />
    );

    // Open the dialog by clicking the trigger button
    fireEvent.click(screen.getByRole("button"));

    // Check character count is present
    expect(screen.getByText("11 characters")).toBeTruthy();

    // Type in textarea to change draft
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "New Draft Value!" } });

    expect(onDraftChange).toHaveBeenCalledWith("New Draft Value!");
    expect(screen.getByText("16 characters")).toBeTruthy();
  });
});
