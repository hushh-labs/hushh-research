import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useState } from "react";
import { GmailWorkspaceNavigation, GmailWorkspacePanels, gmailWorkspaceTab, type GmailWorkspace } from "@/components/gmail/gmail-workspace-navigation";

describe("Gmail workspace navigation", () => {
  it("keeps Gmail focused on Overview, Follow-ups and Receipts", () => {
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
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Follow-ups",
      "Receipts",
    ]);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // KYC is its own screen, not a fourth tab, and nothing else is offered.
    expect(screen.queryByRole("tab", { name: "KYC" })).toBeNull();
    expect(screen.queryByRole("tab", { name: /Inbox assistant|Views/i })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Follow-ups" }));
    expect(onValueChange).toHaveBeenCalledWith("followups");
  });

  it("never offers KYC as a Mail tab, and never lets it select one", () => {
    render(<GmailWorkspaceNavigation value="kyc" onValueChange={vi.fn()} />);
    expect(screen.queryByRole("tab", { name: "KYC" })).toBeNull();
    // KYC is its own screen: if it ever reached the tabs they fall back to the default, not to Follow-ups.
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Follow-ups" })).toHaveAttribute("aria-selected", "false");
    expect(gmailWorkspaceTab("kyc")).toBe("overview");
    expect(gmailWorkspaceTab("receipts")).toBe("receipts");
  });

  it("links Mail tabs to retained panes without exposing inactive controls", () => {
    function Workspace() {
      const [value, setValue] = useState<GmailWorkspace>("followups");
      return <>
        <GmailWorkspaceNavigation value={value} onValueChange={setValue} />
        <GmailWorkspacePanels value={value} onValueChange={setValue} panels={{
          overview: <p>Mail overview</p>,
          followups: <input aria-label="Synthetic KYC draft" defaultValue="Draft retained" />,
          receipts: <p>Saved receipts</p>,
        }} />
      </>;
    }
    const view = render(<Workspace />);
    const draft = screen.getByRole("textbox", { name: "Synthetic KYC draft" });
    fireEvent.change(draft, { target: { value: "Edited draft" } });
    const followups = screen.getByRole("tabpanel", { name: "Follow-ups" });
    expect(screen.getByRole("tablist", { name: "Gmail workspace" })).toHaveAttribute("data-top-shell-tab-set", "gmail-workspace");
    expect(screen.getByRole("tab", { name: "Follow-ups" })).toHaveAttribute("aria-controls", followups.id);
    fireEvent.click(screen.getByRole("tab", { name: "Receipts" }));
    expect(screen.getByRole("tabpanel", { name: "Receipts" })).toBeVisible();
    expect(followups).toHaveAttribute("inert", "");
    expect(screen.queryByRole("textbox", { name: "Synthetic KYC draft" })).toBeNull();
    expect(view.container.querySelectorAll('[role="tabpanel"]')).toHaveLength(3);
    fireEvent.click(screen.getByRole("tab", { name: "Follow-ups" }));
    expect(screen.getByRole("textbox", { name: "Synthetic KYC draft" })).toBe(draft);
    expect(draft).toHaveValue("Edited draft");
  });
});
