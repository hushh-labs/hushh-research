import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useState } from "react";
import { GmailWorkspaceNavigation, GmailWorkspacePanels, type GmailWorkspace } from "@/components/gmail/gmail-workspace-navigation";

describe("Gmail workspace navigation", () => {
  it("keeps Mail focused on Overview and Views", () => {
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
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Views" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Views" }));
    expect(onValueChange).toHaveBeenCalledWith("views");
  });

  it("links Mail tabs to retained panes without exposing inactive KYC controls", () => {
    function Workspace() {
      const [value, setValue] = useState<GmailWorkspace>("kyc");
      return <>
        <GmailWorkspaceNavigation value={value} onValueChange={setValue} />
        <GmailWorkspacePanels value={value} onValueChange={setValue} panels={{
          overview: <p>Mail overview</p>,
          views: <input aria-label="Synthetic KYC draft" defaultValue="Draft retained" />,
        }} />
      </>;
    }
    const view = render(<Workspace />);
    const draft = screen.getByRole("textbox", { name: "Synthetic KYC draft" });
    fireEvent.change(draft, { target: { value: "Edited draft" } });
    const views = screen.getByRole("tabpanel", { name: "Views" });
    expect(screen.getByRole("tablist", { name: "Gmail workspace" })).toHaveAttribute("data-top-shell-tab-set", "gmail-workspace");
    expect(screen.getByRole("tab", { name: "Views" })).toHaveAttribute("aria-controls", views.id);
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toBeVisible();
    expect(views).toHaveAttribute("inert", "");
    expect(screen.queryByRole("textbox", { name: "Synthetic KYC draft" })).toBeNull();
    expect(view.container.querySelectorAll('[role="tabpanel"]')).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "Views" }));
    expect(screen.getByRole("textbox", { name: "Synthetic KYC draft" })).toBe(draft);
    expect(draft).toHaveValue("Edited draft");
  });
});
