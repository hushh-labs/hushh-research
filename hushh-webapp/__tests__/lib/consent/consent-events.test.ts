import { describe, it, expect } from "vitest";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";

describe("consent-events constants", () => {
  it("CONSENT_ACTION_COMPLETE_EVENT has the exact value 'consent-action-complete'", () => {
    expect(CONSENT_ACTION_COMPLETE_EVENT).toBe("consent-action-complete");
  });

  it("CONSENT_STATE_CHANGED_EVENT has the exact value 'consent-state-changed'", () => {
    expect(CONSENT_STATE_CHANGED_EVENT).toBe("consent-state-changed");
  });

  it("the two event name constants are distinct strings", () => {
    expect(CONSENT_ACTION_COMPLETE_EVENT).not.toBe(CONSENT_STATE_CHANGED_EVENT);
  });

  it("both constants are non-empty strings", () => {
    expect(typeof CONSENT_ACTION_COMPLETE_EVENT).toBe("string");
    expect(CONSENT_ACTION_COMPLETE_EVENT.length).toBeGreaterThan(0);
    expect(typeof CONSENT_STATE_CHANGED_EVENT).toBe("string");
    expect(CONSENT_STATE_CHANGED_EVENT.length).toBeGreaterThan(0);
  });
});