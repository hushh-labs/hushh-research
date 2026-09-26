import { describe, expect, it } from "vitest";

import {
  ONE_CLOUD_SETUP_PREREQUISITE_ID,
  ONE_RUNTIME_SETUP_PREREQUISITE_ID,
  ONE_SETUP_CAPABILITY_IDS,
  ONE_SETUP_PREREQUISITE_IDS,
  normalizeOneSetupCapabilityId,
} from "@/lib/onboarding/setup-capability-ids";

describe("setup capability identity contract", () => {
  it("keeps one canonical seven-capability order", () => {
    expect(ONE_SETUP_CAPABILITY_IDS).toEqual([
      "gmail",
      "calendar",
      "location",
      "email",
      "finance",
      "ria",
      "connected-systems",
    ]);
  });

  it("puts the cloud before AI access, and keeps both out of the capability list", () => {
    // The product order: a person authorizes their own cloud, and only then chooses
    // how their agent reaches a model -- by which point their own project's ADC
    // usually answers it.
    expect(ONE_SETUP_PREREQUISITE_IDS).toEqual(["cloud", "connections"]);
    // A cloud is WHERE the agent lives, not something it does, so it must never enter
    // the generated action catalog.
    expect(normalizeOneSetupCapabilityId("cloud")).toBeNull();
    expect(ONE_SETUP_CAPABILITY_IDS).not.toContain("cloud");
  });

  it("names the runtime prerequisite explicitly rather than deriving it by index", () => {
    // This constant used to be `ONE_SETUP_PREREQUISITE_IDS[0]`. Prepending "cloud"
    // silently redefined it, so `hasOneRuntimeChoice` would have started answering
    // "did they set up a cloud?", the AI-access gate would have been satisfied by the
    // wrong step, and nothing anywhere would have raised.
    //
    // Broken on purpose: set it back to ONE_SETUP_PREREQUISITE_IDS[0] and this fails.
    expect(ONE_RUNTIME_SETUP_PREREQUISITE_ID).toBe("connections");
    expect(ONE_CLOUD_SETUP_PREREQUISITE_ID).toBe("cloud");
    expect(ONE_RUNTIME_SETUP_PREREQUISITE_ID).not.toBe(
      ONE_SETUP_PREREQUISITE_IDS[0],
    );
  });

  it("contains stale durable capability values to the setup hub", () => {
    expect(normalizeOneSetupCapabilityId(" gmail ")).toBe("gmail");
    expect(normalizeOneSetupCapabilityId("pkm")).toBeNull();
    expect(normalizeOneSetupCapabilityId("consent")).toBeNull();
    expect(normalizeOneSetupCapabilityId("marketplace")).toBeNull();
    expect(normalizeOneSetupCapabilityId(null)).toBeNull();
  });
});
