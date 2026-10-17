/** A person who never chose a tier reads "Not chosen yet" and is sent to choose, never "Shared". */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentSettingsPanel } from "@/components/profile/agent-settings-panel";
import { NO_UPDATE } from "@/lib/feed/use-agent-deployment-follow";
import { ROUTES } from "@/lib/navigation/routes";

const mocks = vi.hoisted(() => ({ follow: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/feed/use-agent-deployment-follow", async (original) => ({
  ...(await original<object>()),
  useAgentDeploymentFollow: mocks.follow,
}));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.follow.mockReturnValue({
    status: { hostingMode: "unplaced" },
    update: NO_UPDATE,
    refresh: vi.fn(),
  });
});

it("labels an unplaced person honestly and opens the tier chooser", () => {
  render(<AgentSettingsPanel kind="hosting" userId="owner" />);
  expect(screen.getByText("Not chosen yet")).toBeInTheDocument();
  expect(screen.queryByText("Current")).toBeNull();
  fireEvent.click(screen.getByText("Hussh Shared"));
  expect(mocks.push).toHaveBeenCalledWith(ROUTES.ONE_SETUP_CLOUD);
});

it("tells an unplaced person updates come after setup", () => {
  render(<AgentSettingsPanel kind="software-updates" userId="owner" />);
  expect(screen.getByText("Available after setup finishes")).toBeInTheDocument();
});
