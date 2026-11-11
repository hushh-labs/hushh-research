// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSmsCallHost, scheduleSmsCall, setSmsCallContact, smsCallSelection, suppressScheduledSmsCall } from "@/lib/direct-messages/sms-call-escalation";

vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  appInteractionCoordinator: { getLifecycleSnapshot: () => ({ state: "active" }) },
}));

const reservation = { callId: "reserved-call", delayMs: 10_000 };
let removeHost: () => void;
const start = vi.fn();
const unavailable = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  removeHost = registerSmsCallHost({ ownerId: "sender", deviceId: "call-device", start, unavailable });
  setSmsCallContact("sender", "contact");
});

afterEach(() => {
  removeHost();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  start.mockClear();
  unavailable.mockClear();
});

describe("automatic SMS calls", () => {
  it("binds the chosen contact to the registered device and starts once after the server delay", () => {
    expect(smsCallSelection("other-account")).toBeUndefined();
    expect(smsCallSelection("sender")).toEqual({ callDeviceId: "call-device", callRecipientUserId: "contact" });
    scheduleSmsCall("sender", "incident", "contact", reservation);
    scheduleSmsCall("sender", "incident", "contact", reservation);
    vi.advanceTimersByTime(9_999);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledExactlyOnceWith({ callId: "reserved-call", incidentId: "incident" });
    scheduleSmsCall("sender", "incident", "contact", reservation);
    vi.advanceTimersByTime(10_000);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not start if the original owner leaves or switches the selected contact", () => {
    scheduleSmsCall("sender", "incident", "contact", reservation);
    setSmsCallContact("sender", "");
    vi.advanceTimersByTime(10_000);
    expect(start).not.toHaveBeenCalled();
    setSmsCallContact("sender", "contact");
    scheduleSmsCall("sender", "incident-2", "contact", { ...reservation, callId: "another-call" });
    removeHost();
    vi.advanceTimersByTime(10_000);
    expect(start).not.toHaveBeenCalled();
  });

  it("reports an inactive sender without opening a call", () => {
    scheduleSmsCall("sender", "incident", "contact", reservation);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.advanceTimersByTime(10_000);
    expect(start).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it("suppresses a pending call when the owner stops the alert, including a replay", () => {
    scheduleSmsCall("sender", "incident", "contact", reservation);
    suppressScheduledSmsCall("sender");
    scheduleSmsCall("sender", "incident", "contact", reservation);
    vi.advanceTimersByTime(10_000);
    expect(start).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
  });
});
