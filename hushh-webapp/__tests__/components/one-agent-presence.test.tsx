import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { OneAgentPresence } from "@/components/dashboard/one-agent-presence";

// The status read moved from a bare `apiJson` to a service method, because
// `apiFetch` does not attach auth and `getFirebaseToken` is private to ApiService.
// Mocking the transport rather than the service is what let the unauthenticated
// call ship: the test supplied a payload the real endpoint would have 401'd on.
vi.mock("@/lib/services/api-service", () => ({
  // getPersonalAgentStatus drives the chip; wakePod is now called by the proactive-wake
  // hook the chip mounts (best-effort, swallowed on failure) -- mock it so it is a spy,
  // not an undefined call.
  ApiService: {
    getPersonalAgentStatus: vi.fn(),
    wakePod: vi.fn().mockResolvedValue({ state: "awake", etaMs: 0 }),
  },
}));

// The chip reads the vault owner token (for the rebuild path) and the router (to route a
// gone project to cloud reconnect). Neither is provided by a bare render, so mock both --
// this test had rendered the component without a VaultProvider since the rebuild handler
// landed, and threw before asserting anything.
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vault-owner-token" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const mockStatus = vi.mocked(ApiService.getPersonalAgentStatus);

afterEach(() => {
  mockStatus.mockReset();
});

describe("OneAgentPresence", () => {
  // Silence, not "Reserved". This test previously called rendering "Reserved" before
  // any data arrived "honest", and it was the opposite: "Reserved" carries the
  // sentence "Reserved and ready to activate", a positive claim about infrastructure
  // that is held. A person with no agent read that as an agent waiting for them.
  it("claims nothing while the first read is still in flight", () => {
    mockStatus.mockReturnValue(new Promise(() => {})); // pending, never resolves
    render(<OneAgentPresence />);
    expect(screen.queryByLabelText("Your Agent One")).toBeNull();
  });

  it("shows 'Online' once the agent is provisioned", async () => {
    mockStatus.mockResolvedValue({ state: "active", hushhId: "ha1_abc" });
    render(<OneAgentPresence />);
    expect(await screen.findByText("Online")).toBeTruthy();
  });

  // Founder directive 2026-09-02: an indicator, not a card. The explanatory
  // sentences ("Asleep to save you money", "Live and yours, isolated to you
  // alone") were true and are now said once during setup, not on every visit.
  it("carries no explanatory body copy", async () => {
    mockStatus.mockResolvedValue({ state: "active", hushhId: "ha1_abc" });
    render(<OneAgentPresence />);
    const chip = await screen.findByTestId("one-agent-presence");
    expect(chip.textContent).not.toMatch(/isolated to you alone|save you money/i);
    expect((chip.textContent || "").length).toBeLessThan(40);
  });

  it("says nothing when the status call errors", async () => {
    // A network failure is not evidence of a reserved agent. The follow hook keeps
    // the last known value on a transient failure; when there is no last known
    // value there is nothing to say, and saying nothing is the only true option.
    mockStatus.mockRejectedValue(new Error("network down"));
    render(<OneAgentPresence />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(screen.queryByLabelText("Your Agent One")).toBeNull();
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
    expect(screen.queryByText("Online")).toBeNull();
  });

  // Health is reported ONLY when the liveness sweep reached a real verdict. The
  // backend omits it rather than defaulting to "healthy", so a live-but-unhealthy
  // agent is the one case where the badge "Live" on its own misleads.
  // `degraded` and `unreachable` are the real wire values. This used to mock
  // "unhealthy", which the backend cannot produce (`_HEALTH_BY_REGISTRY_HEALTH_STATE`
  // is a pass-through of healthy/degraded/unreachable/sleeping). It passed only
  // because an invented value satisfied a `!== "healthy"` denylist, so the test and
  // the implementation were loosely wrong together.
  it.each(["degraded", "unreachable"])(
    "says so when a live agent reports '%s'",
    async (health) => {
      mockStatus.mockResolvedValue({ state: "active", health });
      render(<OneAgentPresence />);
      expect(await screen.findByText("Not responding")).toBeTruthy();
      expect(screen.queryByText("Online")).toBeNull();
    },
  );

  // The defect this whole pass exists to fix. An economy pod is SUPPOSED to sleep
  // between turns; `pod_liveness_service` documents `sleeping` as emphatically not a
  // fault and proposes neither probe nor heal for it. Reporting it as "Not
  // responding" told every idle owner their agent was broken.
  it("treats 'sleeping' as normal, never as a fault", async () => {
    mockStatus.mockResolvedValue({ state: "active", health: "sleeping" });
    render(<OneAgentPresence />);
    expect(await screen.findByText("Asleep")).toBeTruthy();
    expect(screen.queryByText("Not responding")).toBeNull();
  });

  it("keeps saying 'Online' when the backend sent no health verdict at all", async () => {
    // Absent means absent. Treating a missing verdict as unhealthy would invent
    // the same claim in the opposite direction.
    mockStatus.mockResolvedValue({ state: "active" });
    render(<OneAgentPresence />);
    expect(await screen.findByText("Online")).toBeTruthy();
    expect(screen.queryByText("Not responding")).toBeNull();
  });

  // Every one of these is "we do not know", and none of them is evidence of a
  // reserved agent. The narrowing (explicit list, so an inherited key like
  // "toString" can never be mistaken for a state) is unchanged and still asserted
  // here; what changed is where it lands. It used to land on a claim.
  it.each([
    ["a state this build has never heard of", { state: "quantum_entangling" }],
    ["an inherited object key", { state: "toString" }],
    ["a non-string state", { state: 7 }],
    ["no state at all", {}],
    ["a null payload", null],
  ])("claims nothing for %s", async (_label, payload) => {
    mockStatus.mockResolvedValue(payload);
    render(<OneAgentPresence />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(screen.queryByLabelText("Your Agent One")).toBeNull();
    expect(screen.queryByText("Reserved")).toBeNull();
  });
  // ---- where the agent lives ------------------------------------------------
  //
  // Where it lives is the product, not an implementation detail -- but it is not
  // worth two lines on every visit either (founder, 2026-09-02). Since the chip
  // became an indicator it travels as the tooltip, and these tests follow it
  // there: the claim each tier earns is unchanged, only where it is written.

  it("says where a hosted agent lives, and offers the move", async () => {
    mockStatus.mockResolvedValue({
      state: "active",
      hushhId: "ha1_abc",
      deploymentTarget: "gcp",
    });
    render(<OneAgentPresence />);

    const chip = await screen.findByTestId("one-agent-presence");
    expect(chip.getAttribute("title")).toMatch(/hosted by hussh/i);
  });

  it("makes the claim the hosted tier actually earns", async () => {
    // "hussh does not read this pod" is honest for a pod hussh operates.
    // "hussh cannot read this pod" is the sentence only the user-owned targets
    // earn, and the difference is the whole point of the move button.
    mockStatus.mockResolvedValue({
      state: "active",
      hushhId: "ha1_abc",
      deploymentTarget: "gcp",
    });
    render(<OneAgentPresence />);

    const where =
      (await screen.findByTestId("one-agent-presence")).getAttribute("title") || "";
    expect(where).toMatch(/sealed to your agent/i);
    expect(where).not.toMatch(/cannot read/i);
  });

  it("prefers the person's own project when they have one", async () => {
    // A user-owned row must never render the hosted line, even transiently:
    // telling someone who owns their compute that hussh hosts it is the one
    // wrong answer this surface can give.
    mockStatus.mockResolvedValue({
      state: "active",
      hushhId: "ha1_abc",
      deploymentTarget: "user_gcp",
      cloudProject: "their-own-project",
      cloudRegion: "us-central1",
    });
    render(<OneAgentPresence />);

    const where =
      (await screen.findByTestId("one-agent-presence")).getAttribute("title") || "";
    expect(where).toMatch(/their-own-project/);
    expect(where).not.toMatch(/hosted by hussh/i);
  });
});
