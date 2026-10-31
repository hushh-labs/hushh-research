import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeGoogleOAuthSettlement,
  settleGoogleOAuthPopup,
  watchGoogleOAuthSettlementAck,
} from "@/lib/google/google-oauth-popup";

const attempt = {
  version: 1 as const, attemptId: "synthetic-ack-attempt", service: "calendar" as const,
  startedAt: Date.now(), ownerId: "synthetic-owner",
};
const ack = (attemptId: string) => ({ schemaVersion: 1, type: "google_oauth_settlement_ack", attemptId });
const setOpener = (value: unknown) => Object.defineProperty(window, "opener", { configurable: true, value });

describe("settling a Google popup", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setOpener(null);
    window.localStorage.clear();
  });

  it("tells a reachable opener, focuses it, then closes itself", () => {
    const opener = { postMessage: vi.fn(), focus: vi.fn() };
    setOpener(opener);
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    settleGoogleOAuthPopup(attempt, "succeeded");
    expect(opener.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "google_oauth_settlement", attemptId: attempt.attemptId, outcome: "succeeded" }),
      window.location.origin,
    );
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(close).toHaveBeenCalledOnce();
  });

  it("still settles through storage and closes when Google severed the opener", () => {
    setOpener(null);
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    expect(() => settleGoogleOAuthPopup(attempt, "failed", "Could not connect.")).not.toThrow();
    expect(window.localStorage.getItem("one_google_oauth_popup_settlement_v1")).toContain(attempt.attemptId);
    vi.runAllTimers();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not let a refused focus prevent the close", () => {
    setOpener({ postMessage: vi.fn(), focus: vi.fn(() => { throw new Error("blocked"); }) });
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    settleGoogleOAuthPopup(attempt, "succeeded");
    vi.runAllTimers();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("settlement acknowledgement", () => {
  let focus: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { focus = vi.spyOn(window, "focus").mockImplementation(() => undefined); });
  afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

  it("brings the original page forward when it acknowledges, and survives a refused focus", () => {
    acknowledgeGoogleOAuthSettlement(attempt.attemptId);
    expect(focus).toHaveBeenCalledOnce();
    focus.mockImplementation(() => { throw new Error("blocked"); });
    expect(() => acknowledgeGoogleOAuthSettlement(attempt.attemptId)).not.toThrow();
  });

  it("reaches a popup listening for the same attempt through its window", () => {
    const onAck = vi.fn();
    const stop = watchGoogleOAuthSettlementAck(attempt.attemptId, onAck);
    const popup = { postMessage: vi.fn() } as unknown as Window;
    acknowledgeGoogleOAuthSettlement(attempt.attemptId, popup);
    expect(popup.postMessage).toHaveBeenCalledWith(ack(attempt.attemptId), window.location.origin);
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, data: ack(attempt.attemptId) }));
    expect(onAck).toHaveBeenCalledOnce();
    stop();
  });

  it("reaches a severed popup through the same-origin storage event", () => {
    const onAck = vi.fn();
    const stop = watchGoogleOAuthSettlementAck(attempt.attemptId, onAck);
    window.dispatchEvent(new StorageEvent("storage", {
      key: "one_google_oauth_popup_ack_v1", newValue: JSON.stringify({ ...ack(attempt.attemptId), sentAt: Date.now() }),
    }));
    expect(onAck).toHaveBeenCalledOnce();
    stop();
  });

  it("sees an acknowledgement that landed before the popup started listening", () => {
    acknowledgeGoogleOAuthSettlement(attempt.attemptId);
    const onAck = vi.fn();
    watchGoogleOAuthSettlementAck(attempt.attemptId, onAck);
    expect(onAck).toHaveBeenCalledOnce();
    // It is consumed, so a later popup for the same id does not inherit it.
    const again = vi.fn();
    watchGoogleOAuthSettlementAck(attempt.attemptId, again);
    expect(again).not.toHaveBeenCalled();
  });

  it("ignores another attempt, another origin, malformed data and a stopped watch", () => {
    const onAck = vi.fn();
    const stop = watchGoogleOAuthSettlementAck(attempt.attemptId, onAck);
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, data: ack("someone-elses-attempt") }));
    window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", data: ack(attempt.attemptId) }));
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, data: { type: "google_oauth_settlement_ack" } }));
    window.dispatchEvent(new StorageEvent("storage", { key: "one_google_oauth_popup_ack_v1", newValue: "{not json" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: JSON.stringify(ack(attempt.attemptId)) }));
    expect(onAck).not.toHaveBeenCalled();
    stop();
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, data: ack(attempt.attemptId) }));
    expect(onAck).not.toHaveBeenCalled();
  });

  it("never writes an acknowledgement for an invalid attempt id", () => {
    acknowledgeGoogleOAuthSettlement("x");
    expect(window.localStorage.getItem("one_google_oauth_popup_ack_v1")).toBeNull();
  });
});
