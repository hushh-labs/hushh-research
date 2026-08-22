import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSectionDropdown } from "@/components/app-ui/agent-section-dropdown";
import { getAgentSections } from "@/lib/navigation/agent-sections";
import { ROUTES } from "@/lib/navigation/routes";
import { useKaiSession } from "@/lib/stores/kai-session-store";

const navigationMock = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: navigationMock.push,
  }),
}));

describe("AgentSectionDropdown", () => {
  beforeEach(() => {
    navigationMock.push.mockReset();
    useKaiSession.getState().clear();
  });

  it("shows the active agent section from the current route and opens the searchable list", async () => {
    render(<AgentSectionDropdown pathname={ROUTES.KAI_ANALYSIS} />);

    const trigger = screen.getByRole("combobox", {
      name: "Switch agent section",
    });
    expect(trigger.textContent).toContain("Finance");

    // Regression: PopoverContent previously passed the conditional scrim +
    // Radix Content as two JSX siblings, which crashed every popover on open
    // with "React.Children.only expected to receive a single React element
    // child." Opening this dropdown must never throw.
    expect(() => fireEvent.click(trigger)).not.toThrow();

    expect(await screen.findByTestId("agent-section-search")).toBeTruthy();
    expect(screen.getByTestId("top_agent_section_finance")).toBeTruthy();
    expect(screen.getByTestId("top_agent_section_ria")).toBeTruthy();
    expect(screen.getByTestId("top_agent_section_gmail")).toBeTruthy();
    expect(screen.getByTestId("top_agent_section_consent")).toBeTruthy();
    expect(screen.getByTestId("top_agent_section_pkm")).toBeTruthy();
    expect(screen.getByTestId("top_agent_section_connected-systems")).toBeTruthy();
    expect(
      document.querySelectorAll('[data-testid^="top_agent_section_"]').length,
    ).toBe(getAgentSections().length);
    // Branded Solar glyphs retain their own contrast treatment in cmdk rows.
    expect(
      screen.getByTestId("top_agent_section_finance").querySelector("svg"),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-slot="popover-content"]')?.className,
    ).toContain("w-[360px]");
  });

  it("navigates through the shared agent section registry", async () => {
    render(<AgentSectionDropdown pathname={ROUTES.ONE_HOME} />);

    fireEvent.click(
      screen.getByRole("combobox", { name: "Switch agent section" }),
    );
    fireEvent.click(await screen.findByTestId("top_agent_section_email"));

    await waitFor(() =>
      expect(navigationMock.push).toHaveBeenCalledWith(ROUTES.ONE_KYC),
    );
    expect(useKaiSession.getState().lastAgentNavScope).toBe("one");
    expect(useKaiSession.getState().lastAgentSectionId).toBe("email");
  });

  it("preserves the prior section label on common routes", () => {
    useKaiSession.getState().setAgentNavigationContext({
      scope: "investor",
      sectionId: "finance",
    });

    render(<AgentSectionDropdown pathname={ROUTES.PROFILE} />);

    expect(
      screen.getByRole("combobox", { name: "Switch agent section" })
        .textContent,
    ).toContain("Finance");
  });
});
