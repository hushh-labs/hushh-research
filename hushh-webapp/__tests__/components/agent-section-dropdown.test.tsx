import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSectionDropdown } from "@/components/app-ui/agent-section-dropdown";
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

  it("shows the active agent section from the current route", async () => {
    render(<AgentSectionDropdown pathname={ROUTES.KAI_ANALYSIS} />);

    const trigger = screen.getByRole("button", {
      name: "Switch agent section",
    });
    expect(trigger.textContent).toContain("Finance");

    fireEvent.keyDown(trigger, { key: "ArrowDown", code: "ArrowDown" });

    expect(await screen.findByTestId("top_agent_section_finance")).toBeTruthy();
    expect(screen.getByTestId("top_agent_section_gmail")).toBeTruthy();
    expect(screen.getByTestId("top_agent_section_consent")).toBeTruthy();
  });

  it("navigates through the shared agent section registry", async () => {
    render(<AgentSectionDropdown pathname={ROUTES.ONE_HOME} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Switch agent section" }), {
      key: "ArrowDown",
      code: "ArrowDown",
    });
    fireEvent.click(await screen.findByTestId("top_agent_section_gmail"));

    await waitFor(() =>
      expect(navigationMock.push).toHaveBeenCalledWith(ROUTES.GMAIL),
    );
    expect(useKaiSession.getState().lastAgentNavScope).toBe("one");
    expect(useKaiSession.getState().lastAgentSectionId).toBe("gmail");
  });

  it("preserves the prior section label on common routes", () => {
    useKaiSession.getState().setAgentNavigationContext({
      scope: "investor",
      sectionId: "finance",
    });

    render(<AgentSectionDropdown pathname={ROUTES.PROFILE} />);

    expect(
      screen.getByRole("button", { name: "Switch agent section" }).textContent,
    ).toContain("Finance");
  });
});
