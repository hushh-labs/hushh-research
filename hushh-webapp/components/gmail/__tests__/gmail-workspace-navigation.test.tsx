import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GmailWorkspaceNavigation } from "@/components/gmail/gmail-workspace-navigation";

describe("Gmail workspace navigation", () => {
  it("keeps Gmail focused on overview, receipts, and verification", () => {
    const onValueChange = vi.fn();

    render(
      <GmailWorkspaceNavigation
        value="overview"
        onValueChange={onValueChange}
      />,
    );

    expect(
      screen.getByRole("tablist", { name: "Gmail workspace" }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Receipts" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Verification" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: /Inbox assistant/i })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Verification" }));
    expect(onValueChange).toHaveBeenCalledWith("verification");
  });
});
