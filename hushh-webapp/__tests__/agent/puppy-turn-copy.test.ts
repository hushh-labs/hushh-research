import { describe, expect, it } from "vitest";

import {
  puppyCatalogMessage,
  puppyCatalogProblem,
  puppyFailureIsRetryable,
  puppyFailureMessage,
  puppyMachineNoun,
  puppyStageLabel,
  puppyThoughtLabel,
  type PuppyTurnStage,
} from "@/lib/agent/puppy-turn-copy";

const STAGES: PuppyTurnStage[] = ["checking", "connecting", "reading", "thinking", "answering", "stopping"];
const REASONS = [
  "PUPPY_OFFLINE", "PUPPY_BUSY", "PUPPY_REVOKED", "PUPPY_CATALOG_STALE", "MODEL_UNAVAILABLE",
  "PRIVATE_AGENT_UNLOCK_REQUIRED", "PUPPY_CANCEL_UNCONFIRMED", "PUPPY_REQUIRES_BYOC_POD", "SOMETHING_NEW",
];

describe("Puppy turn copy", () => {
  it("names the machine the way the device names itself", () => {
    expect(puppyMachineNoun("Kushal's MacBook Pro")).toBe("your Mac");
    expect(puppyMachineNoun("studio-linux")).toBe("your computer");
    expect(puppyMachineNoun("Mac mini")).toBe("your Mac");
    expect(puppyMachineNoun("iMac")).toBe("your Mac");
    // "mac" inside another word is not a Mac.
    expect(puppyMachineNoun("build machine")).toBe("your computer");
    expect(puppyMachineNoun("Mackenzie's PC")).toBe("your computer");
    expect(puppyMachineNoun("macro-vm")).toBe("your computer");
    // No name: say nothing we do not know.
    expect(puppyMachineNoun(null)).toBe("your computer");
    expect(puppyStageLabel("connecting", 5, "your computer")).toBe("Waking your agent and your computer…");
  });

  it("never uses an em dash or a raw code in anything it says", () => {
    const lines = [
      ...STAGES.flatMap((stage) => [0, 10, 60].map((seconds) => puppyStageLabel(stage, seconds))),
      ...REASONS.map((reason) => puppyFailureMessage(reason, { timedOut: false, cancelled: false })),
      puppyFailureMessage("x", { timedOut: true, cancelled: false }),
      ...(["checking", "waking", "dispatched"] as const).map((phase) =>
        puppyFailureMessage("x", { timedOut: true, cancelled: false, phase })),
      ...(["waking", "not-shared", "machine", "hub", "agent"] as const).flatMap((problem) =>
        [true, false].map((remembered) => puppyCatalogMessage(problem, "your Mac", remembered))),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/—/);
      expect(line).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
  });

  it("never claims another target answered, and never blames the Mac for a code it cannot place", () => {
    expect(puppyFailureMessage("SOMETHING_NEW", { timedOut: false, cancelled: false }, "your Mac"))
      .toBe("Puppy couldn't finish this answer. Nothing was sent anywhere else.");
  });

  it("names the private agent when the agent, not the Mac, failed", () => {
    const outcome = { timedOut: false, cancelled: false };
    const agentCodes = [
      "PRIVATE_AGENT_UNAVAILABLE", "POD_DIRECT_UNAVAILABLE:unknown", "AGENT_UNREACHABLE",
      "AGENT_NOT_YOURS:session_required", "PUPPY_ACCESS_REFUSED", "PUPPY_STREAM_INTERRUPTED",
    ];
    for (const code of agentCodes) {
      const line = puppyFailureMessage(code, outcome, "your Mac");
      expect(line, code).toMatch(/private agent/);
      expect(line, code).not.toMatch(/Mac/);
    }
    // The connection step's own typed code keeps One chat's owner-safe words.
    expect(puppyFailureMessage("POD_DIRECT_UNAVAILABLE:ENDPOINT_UNAVAILABLE:POD_DIRECT_NOT_READY", outcome, "your Mac"))
      .toMatch(/^Your private agent connection is not ready/);
    // A Mac refusal wrapped by the agent is still the Mac's.
    expect(puppyFailureMessage("POD_DIRECT_UNAVAILABLE:PUPPY_BUSY", outcome, "your Mac"))
      .toBe("Your Mac is still on another answer. Try again in a moment.");
    expect(puppyFailureMessage("PUPPY_ACTIVATION_UNAVAILABLE:503", outcome, "your Mac"))
      .toBe("Hussh couldn't ask your Mac to wake up. Try again in a moment.");
  });

  it("blames a timeout on the side the turn was waiting for", () => {
    const timedOut = (phase: "checking" | "waking" | "dispatched") =>
      puppyFailureMessage("x", { timedOut: true, cancelled: false, phase }, "your Mac");
    expect(timedOut("checking")).toBe("Hussh took too long to check your private agent. Try again in a moment.");
    expect(timedOut("waking")).toBe("Your private agent and your Mac took too long to wake up. Try again in a minute.");
    expect(timedOut("dispatched")).toBe("Your Mac took too long to answer. Check that it's awake, then try again.");
  });

  it("places a failed model-list read on its side", () => {
    expect(puppyCatalogProblem(new Error("anything"), true)).toBe("waking");
    // Once the agent answered, a timeout is the machine still sharing its list.
    expect(puppyCatalogProblem(new Error("anything"), true, true)).toBe("not-shared");
    expect(puppyCatalogProblem(new Error("PUPPY_OFFLINE"), false)).toBe("machine");
    expect(puppyCatalogProblem(new Error("PUPPY_ACTIVATION_UNAVAILABLE:503"), false)).toBe("hub");
    expect(puppyCatalogProblem(new Error("POD_DIRECT_UNAVAILABLE:x"), false)).toBe("agent");
    expect(puppyCatalogMessage("waking", "your Mac", false)).toBe("Waking your agent… This can take a minute after a break.");
  });

  it("names the agent, not One, for a bare browser network failure", () => {
    for (const text of ["Failed to fetch", "Load failed"]) {
      const sentence = puppyFailureMessage(text, { timedOut: false, cancelled: false }, "your Mac");
      expect(sentence).toBe("Couldn't reach your private agent. Check your internet connection, then try again.");
    }
  });

  it("offers a retry except after a stop or a removed device", () => {
    expect(puppyFailureIsRetryable("PUPPY_BUSY", false)).toBe(true);
    expect(puppyFailureIsRetryable("PUPPY_BUSY", true)).toBe(false);
    expect(puppyFailureIsRetryable("PUPPY_REVOKED", false)).toBe(false);
  });

  it("reports how long the model reasoned", () => {
    expect(puppyThoughtLabel(null)).toBe("Thinking…");
    expect(puppyThoughtLabel(400)).toBe("Thought for a moment");
    expect(puppyThoughtLabel(8_200)).toBe("Thought for 8s");
  });
});
