import { describe, expect, it } from "vitest";

import fixture from "@/contracts/kai/one-voice-local-intent-evals.v1.json";
import {
  extractGeneratedSlots,
  resolveLocalIntent,
  type OneVoiceIntentContext,
} from "@/lib/voice/local-intent-resolver";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

const baseContext = (
  availableActionIds: string[],
  redactedState: OneVoiceIntentContext["redactedState"] = {},
): OneVoiceIntentContext => ({
  contextRevision: "ctx-location-1",
  catalogVersion: "kai-action-gateway.vnext",
  route: { pathname: "/one/location", screen: "one_location" },
  availableActionIds,
  executableActionIds: availableActionIds,
  redactedState,
});

describe("local Agent One intent resolver", () => {
  it.each(fixture.cases)("passes redacted local fixture $id", (testCase) => {
    const result = resolveLocalIntent(
      testCase.utterance,
      testCase.context,
    );
    expect(result.disposition).toBe(testCase.expected.disposition);
    if (testCase.expected.actionId) {
      expect(result.actionId).toBe(testCase.expected.actionId);
    }
    if (testCase.expected.readCapability) {
      expect(result.readCapability).toBe(testCase.expected.readCapability);
    }
    if (testCase.expected.reason) {
      expect(result.reason).toBe(testCase.expected.reason);
    }
    if (testCase.expected.missingSlots) {
      expect(result.missingSlots).toEqual(testCase.expected.missingSlots);
    }
    if (testCase.expected.slots) {
      expect(result.slots).toEqual(testCase.expected.slots);
    }
  });

  it("maps natural circle language to the generated create action and extracts a bounded name", () => {
    const result = resolveLocalIntent(
      "Hey Agent One, make a circle called Family",
      baseContext(["location.create_circle"]),
    );

    expect(result).toMatchObject({
      disposition: "action",
      agentNamespace: "agent_location",
      actionId: "location.create_circle",
      slots: { name: "Family" },
      confidence: expect.any(Number),
    });
  });

  it("asks only for the missing circle name", () => {
    const result = resolveLocalIntent(
      "Set up a circle for my family",
      baseContext(["location.create_circle"]),
    );

    expect(result.disposition).toBe("action");
    expect(result.actionId).toBe("location.create_circle");
    expect(result.slots).toEqual({ name: "Family" });
  });

  it("returns a clarification rather than executing a nameless circle request", () => {
    const result = resolveLocalIntent(
      "Create one circle",
      baseContext(["location.create_circle"]),
    );

    expect(result).toMatchObject({
      disposition: "clarify",
      actionId: "location.create_circle",
      missingSlots: ["name"],
    });
  });

  it("resolves enable and disable location through authored action ids", () => {
    expect(
      resolveLocalIntent(
        "Turn location sharing on",
        baseContext(["location.resume_updates"]),
      ),
    ).toMatchObject({
      disposition: "action",
      actionId: "location.resume_updates",
    });

    expect(
      resolveLocalIntent(
        "Pause my location updates",
        baseContext(["location.pause_updates"]),
      ),
    ).toMatchObject({
      disposition: "action",
      actionId: "location.pause_updates",
    });
  });

  it("answers Circle counts only from redacted governed state", () => {
    const result = resolveLocalIntent(
      "How many Circles do I have?",
      baseContext([], { circleCount: 3 }),
    );

    expect(result).toMatchObject({
      disposition: "read_answer",
      agentNamespace: "agent_location",
      readCapability: "list_my_location_circles",
      slots: { count: 3 },
    });
  });

  it("answers location status only from fresh redacted state", () => {
    expect(
      resolveLocalIntent(
        "Is my location sharing on?",
        baseContext([], { shareState: "sharing" }),
      ),
    ).toMatchObject({
      disposition: "read_answer",
      readCapability: "read_location_status",
      slots: { enabled: true },
    });

    expect(
      resolveLocalIntent(
        "Do I have location permission?",
        baseContext([], { permissionState: "denied" }),
      ),
    ).toMatchObject({
      disposition: "read_answer",
      readCapability: "read_location_permission",
      slots: { permission: "denied" },
    });

    expect(
      resolveLocalIntent(
        "Is my current location available?",
        baseContext([], { currentLocationState: "available" }),
      ),
    ).toMatchObject({
      disposition: "read_answer",
      readCapability: "read_current_location_status",
      slots: { available: true },
    });
  });

  it("clarifies ambiguous location language", () => {
    expect(
      resolveLocalIntent(
        "Handle my location",
        baseContext(["location.resume_updates", "location.pause_updates"]),
      ),
    ).toMatchObject({ disposition: "clarify", reason: "ambiguous" });
  });

  it("fails closed for SOS sending", () => {
    expect(
      resolveLocalIntent(
        "Ask Agent One to send an SOS",
        baseContext(["location.trigger_sos"]),
      ),
    ).toMatchObject({
      disposition: "unsupported",
      reason: "sos_send_blocked",
    });
  });

  it("routes bare emergency language to the SOS review surface only", () => {
    expect(
      resolveLocalIntent(
        "Help me",
        baseContext(["location.sos_default", "location.open_sos"]),
      ),
    ).toMatchObject({
      disposition: "action",
      actionId: "location.open_sos",
    });
  });

  it("does not propose an action outside the current executable inventory", () => {
    expect(
      resolveLocalIntent(
        "Create a circle called Family",
        baseContext(["location.open_now"]),
      ),
    ).toMatchObject({
      disposition: "unsupported",
      reason: "action_unavailable",
    });
  });

  it("does not treat a discoverable but server-filtered action as executable", () => {
    const result = resolveLocalIntent(
      "open location settings",
      {
        ...baseContext(["location.open_settings"]),
        executableActionIds: [],
      },
    );

    expect(result).toMatchObject({
      disposition: "unsupported",
      reason: "action_unavailable",
    });
  });

  it("does not propose a generated manual-only action", () => {
    const result = resolveLocalIntent(
      "cancel analysis",
      baseContext(["analysis.cancel_active"]),
    );

    expect(result).toMatchObject({
      disposition: "unsupported",
      reason: "action_unavailable",
    });
  });

  it("extracts person and circle slots without swapping their roles", () => {
    const action = getKaiActionById("location.add_to_circle");
    expect(action).toBeDefined();
    expect(extractGeneratedSlots(action!, "add Sarah to Family")).toEqual({
      person: "Sarah",
      circle: "Family",
    });
  });

  it("normalizes a duration and asks for only that missing required slot", () => {
    const result = resolveLocalIntent(
      "share with them",
      baseContext(["location.share_selected"]),
    );

    expect(result).toMatchObject({
      disposition: "clarify",
      actionId: "location.share_selected",
      slots: { person: "them" },
      missingSlots: ["duration_hours"],
    });
  });
});
