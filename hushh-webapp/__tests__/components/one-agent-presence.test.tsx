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

  // The endpoint now reports the real intermediate states. Rendering "Reserved"
  // through them told the person their agent was idle while it was mid-flight.
  it.each([
    ["provisioning", "Setting up"],
    ["connecting", "Connecting"],
    ["failed", "Not ready"],
  ])("renders the '%s' state as '%s'", async (state, badge) => {
    mockApiJson.mockResolvedValue({ state });
    render(<OneAgentPresence />);
    expect(await screen.findByText(badge)).toBeTruthy();
    // Never claims a live pod while one is still being stood up.
    expect(screen.queryByText("Live")).toBeNull();
  });

  it.each([
    ["a state this build has never heard of", { state: "quantum_entangling" }],
    ["an inherited object key", { state: "toString" }],
    ["a non-string state", { state: 7 }],
    ["no state at all", {}],
    ["a null payload", null],
  ])("degrades %s to 'Reserved'", async (_label, payload) => {
    mockApiJson.mockResolvedValue(payload);
    render(<OneAgentPresence />);
    await waitFor(() => expect(screen.getByText("Reserved")).toBeTruthy());
    expect(screen.getByText(/Reserved and ready to activate/)).toBeTruthy();
  });
});
