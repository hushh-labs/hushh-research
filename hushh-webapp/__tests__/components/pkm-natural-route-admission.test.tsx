import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";

const route = vi.hoisted(() => ({ pathname: "/one/pkm/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/components/profile/native-memory-workspace", () => ({
  NativeMemoryWorkspace: () => <div data-testid="memory-workspace" />,
}));
vi.mock("@/components/profile/use-pkm-natural-model", () => ({
  MEMORY_WORKSPACE_TABS: [], cardImpactKey: vi.fn(),
  usePkmNaturalModel: () => ({ authLoading: true }),
}));

describe("Memory route admission", () => {
  it("mounts the workspace on the exported root but not its children", () => {
    route.pathname = "/one/pkm/";
    const view = render(<PkmNaturalPanel />);
    expect(screen.getByTestId("memory-workspace")).toBeInTheDocument();
    route.pathname = "/one/pkm/recent/";
    view.rerender(<PkmNaturalPanel view="recent" />);
    expect(screen.queryByTestId("memory-workspace")).toBeNull();
    expect(screen.getByText("Opening Memory…")).toBeInTheDocument();
  });
});
