import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentGetAppPrompt } from "@/components/agent/agent-get-app-prompt";

describe("AgentGetAppPrompt", () => {
  it("offers the published Hussh One App Store listing", () => {
    render(
      <AgentGetAppPrompt
        open
        onOpenChange={vi.fn()}
        presentation="card"
        returnFocusRef={createRef<HTMLElement>()}
      />,
    );

    const appStoreLink = screen.getByTestId("agent-get-app-link-ios");
    expect(appStoreLink).toHaveAttribute(
      "href",
      "https://apps.apple.com/us/app/hussh-one-personal-agent/id6757718917",
    );
    expect(appStoreLink).toHaveAttribute("target", "_blank");
    expect(appStoreLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByText("Store links aren't available yet.")).not.toBeInTheDocument();
  });
});
