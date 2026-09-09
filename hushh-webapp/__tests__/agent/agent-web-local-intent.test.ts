import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/settings-service", () => ({
  SettingsService: {
    shouldUseLocalAgents: vi.fn(async () => true),
  },
}));

import { HushhAgentWeb } from "@/lib/capacitor/plugins/agent-web";

const state = {
  oneVoiceContext: {
    contextRevision: "ctx-1",
    catalogVersion: "gateway-1",
    availableActionIds: ["location.create_circle"],
    executableActionIds: ["location.create_circle"],
    route: { pathname: "/one/location", screen: "one_location" },
  },
};

describe("web local Agent One boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a bounded action proposal without executing it", async () => {
    const response = await new HushhAgentWeb().handleMessage({
      message: "make a circle called Family",
      userId: "user-1",
      sessionState: state,
    });

    expect(response.intent).toMatchObject({
      disposition: "action",
      actionId: "location.create_circle",
      slots: { name: "Family" },
    });
    expect(response.response).toContain("policy and confirmation");
    expect(response.needsConsent).toBe(false);
  });

  it("does not allow a local voice request to send SOS", async () => {
    const response = await new HushhAgentWeb().handleMessage({
      message: "send an SOS",
      userId: "user-1",
      sessionState: {
        ...state,
        oneVoiceContext: {
          ...state.oneVoiceContext,
          availableActionIds: ["location.trigger_sos"],
        },
      },
    });

    expect(response.intent).toMatchObject({
      disposition: "unsupported",
      reason: "sos_send_blocked",
    });
    expect(response.response).toContain("cannot send an SOS");
  });

  it("refuses to resolve without redacted current app context", async () => {
    const response = await new HushhAgentWeb().handleMessage({
      message: "make a circle called Family",
      userId: "user-1",
      sessionState: {},
    });

    expect(response.intent).toBeUndefined();
    expect(response.response).toContain("current Agent One screen context");
  });
});
