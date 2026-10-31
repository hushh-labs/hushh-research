import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPickerField } from "@/components/app-ui/command-fields";

describe("CommandPickerField", () => {
  it("uses the shared soft accent for pointer and keyboard highlights without changing selection", () => {
    const onSelect = vi.fn();
    render(<CommandPickerField title="Tier" value="ACE" placeholder="Choose tier"
      options={[{ value: "ACE", label: "ACE", description: "ACE conviction band" },
        { value: "KING", label: "KING", description: "KING conviction band" }]}
      onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "ACE" }));
    const option = screen.getByRole("option", { name: /ACE/ });
    expect(option).toHaveClass("hover:bg-[color:var(--app-accent-surface)]");
    expect(option).toHaveClass("data-[selected=true]:bg-[color:var(--app-accent-surface)]");
    expect(option).not.toHaveClass("data-[selected=true]:bg-accent");
    fireEvent.click(screen.getByRole("option", { name: /KING/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: "KING" }));
  });
});
