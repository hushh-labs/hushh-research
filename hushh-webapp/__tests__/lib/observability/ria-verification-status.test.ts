import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above module init, so the spy has to be hoisted with it.
const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/observability/client", () => ({ trackEvent }));

import {
  riaVerificationAction,
  riaVerificationResult,
  trackRiaVerificationStatusChanged,
} from "@/lib/observability/ria-events";

/**
 * `ria_verification_status_changed` was declared in the observability
 * contract, and the event matrix documented an emitter in
 * app/ria/onboarding/page.tsx -- but none existed. Anything built on it would
 * have read a permanent zero, indistinguishable from "nobody verified".
 */
describe("RIA verification status event", () => {
  beforeEach(() => trackEvent.mockReset());

  it.each([
    ["verified", "verified"],
    ["active", "active"],
    ["rejected", "rejected"],
    ["draft", "draft"],
  ] as const)("maps %s onto the contract value %s", (outcome, expected) => {
    expect(riaVerificationAction(outcome)).toBe(expected);
  });

  it("settles an unrecognised status on submitted rather than dropping it", () => {
    // The upstream service may add statuses; the submission still happened.
    expect(riaVerificationAction("awaiting_finra_backfill")).toBe("submitted");
    expect(riaVerificationAction("")).toBe("submitted");
    expect(riaVerificationAction(null)).toBe("submitted");
  });

  it("is case and whitespace insensitive", () => {
    expect(riaVerificationAction("  VERIFIED ")).toBe("verified");
  });

  it("treats a rejection as an expected outcome, not a system error", () => {
    expect(riaVerificationResult("rejected")).toBe("expected_error");
    expect(riaVerificationResult("verified")).toBe("success");
  });

  it("emits the contract event with both required params", () => {
    trackRiaVerificationStatusChanged("verified");
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith("ria_verification_status_changed", {
      action: "verified",
      result: "success",
    });
  });

  it("reports a rejection rather than staying silent about it", () => {
    trackRiaVerificationStatusChanged("rejected");
    expect(trackEvent.mock.calls[0][1]).toEqual({
      action: "rejected",
      result: "expected_error",
    });
  });
});
