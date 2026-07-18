import { describe, expect, it } from "vitest";

import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";

describe("consent-events", () => {
  it("preserves the consent-state-changed event name", () => {
    expect(CONSENT_STATE_CHANGED_EVENT).toBe("consent-state-changed");
  });
});