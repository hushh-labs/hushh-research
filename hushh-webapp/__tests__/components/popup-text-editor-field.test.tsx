import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PopupTextEditorField } from "@/components/app-ui/command-fields";

describe("PopupTextEditorField", () => {
  it("renders an accessible live character counter only when maxLength is provided", () => {
    render(
      <PopupTextEditorField
        title="Investment thesis"
        value=""
        placeholder="Write thesis"
        onSave={() => {}}
        maxLength={2000}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const editor = screen.getByPlaceholderText("Write thesis");
    expect(screen.getByText("0 / 2000")).toBeTruthy();
    expect(editor.getAttribute("aria-describedby")).toBeTruthy();

    fireEvent.change(editor, { target: { value: "A" } });
    expect(screen.getByText("1 / 2000")).toBeTruthy();

    fireEvent.change(editor, { target: { value: "A".repeat(1999) } });
    expect(screen.getByText("1999 / 2000")).toBeTruthy();

    fireEvent.change(editor, { target: { value: "A".repeat(2000) } });
    expect(screen.getByText("2000 / 2000")).toBeTruthy();
  });

  it("prevents the attempted 2001st character from being saved", () => {
    const onSave = vi.fn();
    render(
      <PopupTextEditorField
        title="Investment thesis"
        value=""
        placeholder="Write thesis"
        onSave={onSave}
        maxLength={2000}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByPlaceholderText("Write thesis"), {
      target: { value: "A".repeat(2001) },
    });
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    expect(onSave).toHaveBeenCalledWith("A".repeat(2000));
  });

  it("preserves existing behavior when maxLength is absent", () => {
    render(
      <PopupTextEditorField
        title="Note"
        value=""
        placeholder="Write note"
        onSave={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(screen.queryByText(/\/ 2000/)).toBeNull();
    expect(screen.getByPlaceholderText("Write note").getAttribute("aria-describedby")).toBeNull();
  });
});
