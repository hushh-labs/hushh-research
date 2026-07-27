import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiJson } from "@/lib/services/api-client";
import { OneAgentPresence } from "@/components/dashboard/one-agent-presence";

vi.mock("@/lib/services/api-client", () => ({
  apiJson: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const mockApiJson = vi.mocked(apiJson);

afterEach(() => {
  mockApiJson.mockReset();
});

describe("OneAgentPresence", () => {
  it("shows the honest 'Reserved' state by default", () => {
    mockApiJson.mockReturnValue(new Promise(() => {})); // pending, never resolves
    render(<OneAgentPresence />);
    expect(screen.getByText("Reserved")).toBeTruthy();
    expect(screen.getByText(/Reserved and ready to activate/)).toBeTruthy();
    // Honest: no over-claim of a live pod in the reserved state.
    expect(screen.queryByText(/always on/)).toBeNull();
  });

  it("shows 'Live' once the agent is provisioned", async () => {
    mockApiJson.mockResolvedValue({ state: "active", hushhId: "ha1_abc" });
    render(<OneAgentPresence />);
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.getByText(/Live and yours/)).toBeTruthy();
  });

  it("fails safe to 'Reserved' when the status call errors", async () => {
    mockApiJson.mockRejectedValue(new Error("network down"));
    render(<OneAgentPresence />);
    await waitFor(() => expect(screen.getByText("Reserved")).toBeTruthy());
  });
});
