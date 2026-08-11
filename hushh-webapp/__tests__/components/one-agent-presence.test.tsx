import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { OneAgentPresence } from "@/components/dashboard/one-agent-presence";

// The status read moved from a bare `apiJson` to a service method, because
// `apiFetch` does not attach auth and `getFirebaseToken` is private to ApiService.
// Mocking the transport rather than the service is what let the unauthenticated
// call ship: the test supplied a payload the real endpoint would have 401'd on.
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: vi.fn() },
}));

const mockStatus = vi.mocked(ApiService.getPersonalAgentStatus);

afterEach(() => {
  mockStatus.mockReset();
});

describe("OneAgentPresence", () => {
  it("shows the honest 'Reserved' state by default", () => {
    mockStatus.mockReturnValue(new Promise(() => {})); // pending, never resolves
    render(<OneAgentPresence />);
    expect(screen.getByText("Reserved")).toBeTruthy();
    expect(screen.getByText(/Reserved and ready to activate/)).toBeTruthy();
    // Honest: no over-claim of a live pod in the reserved state.
    expect(screen.queryByText(/always on/)).toBeNull();
  });

  it("shows 'Live' once the agent is provisioned", async () => {
    mockStatus.mockResolvedValue({ state: "active", hushhId: "ha1_abc" });
    render(<OneAgentPresence />);
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.getByText(/Live and yours/)).toBeTruthy();
  });

  it("fails safe to 'Reserved' when the status call errors", async () => {
    mockStatus.mockRejectedValue(new Error("network down"));
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
    mockStatus.mockResolvedValue({ state });
    render(<OneAgentPresence />);
    expect(await screen.findByText(badge)).toBeTruthy();
    // Never claims a live pod while one is still being stood up.
    expect(screen.queryByText("Live")).toBeNull();
  });

  // Health is reported ONLY when the liveness sweep reached a real verdict. The
  // backend omits it rather than defaulting to "healthy", so a live-but-unhealthy
  // agent is the one case where the badge "Live" on its own misleads.
  it("says so when a live agent is not answering health checks", async () => {
    mockStatus.mockResolvedValue({ state: "active", health: "unhealthy" });
    render(<OneAgentPresence />);
    expect(await screen.findByText("Not responding")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("keeps saying 'Live' when the backend sent no health verdict at all", async () => {
    // Absent means absent. Treating a missing verdict as unhealthy would invent
    // the same claim in the opposite direction.
    mockStatus.mockResolvedValue({ state: "active" });
    render(<OneAgentPresence />);
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.queryByText("Not responding")).toBeNull();
  });

  it.each([
    ["a state this build has never heard of", { state: "quantum_entangling" }],
    ["an inherited object key", { state: "toString" }],
    ["a non-string state", { state: 7 }],
    ["no state at all", {}],
    ["a null payload", null],
  ])("degrades %s to 'Reserved'", async (_label, payload) => {
    mockStatus.mockResolvedValue(payload);
    render(<OneAgentPresence />);
    await waitFor(() => expect(screen.getByText("Reserved")).toBeTruthy());
    expect(screen.getByText(/Reserved and ready to activate/)).toBeTruthy();
  });
});
