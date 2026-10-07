import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useState } from "react";
import { GmailWorkspaceNavigation, GmailWorkspacePanels, type GmailWorkspace } from "@/components/gmail/gmail-workspace-navigation";

describe("Gmail workspace navigation", () => {
  it("keeps Gmail focused on overview, KYC, and receipts", () => {
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
    expect(screen.getByRole("tab", { name: "KYC" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Receipts" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: /Inbox assistant/i })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "KYC" }));
    expect(onValueChange).toHaveBeenCalledWith("kyc");
  });

  it("links Mail tabs to retained panes without exposing inactive KYC controls", () => {
    function Workspace() {
      const [value, setValue] = useState<GmailWorkspace>("kyc");
      return <>
        <GmailWorkspaceNavigation value={value} onValueChange={setValue} />
        <GmailWorkspacePanels value={value} onValueChange={setValue} panels={{
          overview: <p>Mail overview</p>,
          kyc: <input aria-label="Synthetic KYC draft" defaultValue="Draft retained" />,
          receipts: <p>Saved receipts</p>,
        }} />
      </>;
    }
    const view = render(<Workspace />);
    const draft = screen.getByRole("textbox", { name: "Synthetic KYC draft" });
    fireEvent.change(draft, { target: { value: "Edited draft" } });
    const kyc = screen.getByRole("tabpanel", { name: "KYC" });
    expect(screen.getByRole("tablist", { name: "Gmail workspace" })).toHaveAttribute("data-top-shell-tab-set", "gmail-workspace");
    expect(screen.getByRole("tab", { name: "KYC" })).toHaveAttribute("aria-controls", kyc.id);
    fireEvent.click(screen.getByRole("tab", { name: "Receipts" }));
    expect(screen.getByRole("tabpanel", { name: "Receipts" })).toBeVisible();
    expect(kyc).toHaveAttribute("inert", "");
    expect(screen.queryByRole("textbox", { name: "Synthetic KYC draft" })).toBeNull();
    expect(view.container.querySelectorAll('[role="tabpanel"]')).toHaveLength(3);
    fireEvent.click(screen.getByRole("tab", { name: "KYC" }));
    expect(screen.getByRole("textbox", { name: "Synthetic KYC draft" })).toBe(draft);
    expect(draft).toHaveValue("Edited draft");
  });
});
