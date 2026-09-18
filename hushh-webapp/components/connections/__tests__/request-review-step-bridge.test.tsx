// @vitest-environment jsdom
/**
 * The `open_request_review` step opens the Consent Center for the exact
 * request and reports only that the screen finished or was left. It never
 * accepts anything itself, and a bad request id is refused, not navigated.
 */
import { render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/one",
  requestInternalAppNavigation: vi.fn(() => true),
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: mocks.requestInternalAppNavigation,
}));

import {
  OPEN_REQUEST_REVIEW_STEP,
  RequestReviewStepBridge,
  requestReviewHref,
} from "@/components/connections/request-review-step-bridge";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";

const REQUEST = "11111111-1111-4111-8111-111111111111";

function emit(stepId: string, payload: Record<string, unknown>) {
  const report = vi.fn();
  act(() => {
    useVoiceSessionStore.getState().emitClientStep(
      { stepId, kind: OPEN_REQUEST_REVIEW_STEP, payload, timeoutS: 600 },
      report,
    );
  });
  return report;
}

describe("RequestReviewStepBridge", () => {
  beforeEach(() => {
    mocks.pathname = "/one";
    mocks.requestInternalAppNavigation.mockClear();
    mocks.requestInternalAppNavigation.mockReturnValue(true);
  });
  afterEach(() => {
    useVoiceSessionStore.getState().reset();
  });

  it("opens the Consent Center for the exact request and reports when the screen finishes", () => {
    render(<RequestReviewStepBridge />);
    const report = emit("step-1", { request_id: REQUEST, user_id: "u-rahul" });
    expect(mocks.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: requestReviewHref(REQUEST),
      source: "voice",
      transitionMode: "contextual",
    });
    expect(requestReviewHref(REQUEST)).toContain(`requestId=${REQUEST}`);
    expect(requestReviewHref(REQUEST)).toContain("tab=pending");
    expect(report).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, { detail: { reconcile: true } }),
      );
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("ok", { outcome: "handled", request_id: REQUEST });
    // Any later completion event is not this step's.
    act(() => {
      window.dispatchEvent(new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT));
    });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("reports 'left' when the person leaves the Consent Center without finishing", () => {
    const view = render(<RequestReviewStepBridge />);
    const report = emit("step-2", { request_id: REQUEST, user_id: "u-rahul" });
    mocks.pathname = "/one/consent?tab=pending";
    view.rerender(<RequestReviewStepBridge />);
    expect(report).not.toHaveBeenCalled();
    mocks.pathname = "/one";
    view.rerender(<RequestReviewStepBridge />);
    expect(report).toHaveBeenCalledWith("ok", { outcome: "left", request_id: REQUEST });
  });

  it("refuses a request id that is not canonical without navigating", () => {
    render(<RequestReviewStepBridge />);
    const report = emit("step-3", { request_id: "Rahul Verma", user_id: "u-rahul" });
    expect(mocks.requestInternalAppNavigation).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("failed", {
      outcome: "failed",
      reason: "invalid_request_id",
    });
  });

  it("reports a failure when navigation is unavailable", () => {
    mocks.requestInternalAppNavigation.mockReturnValue(false);
    render(<RequestReviewStepBridge />);
    const report = emit("step-4", { request_id: REQUEST, user_id: "u-rahul" });
    expect(report).toHaveBeenCalledWith("failed", {
      outcome: "failed",
      reason: "navigation_unavailable",
      request_id: REQUEST,
    });
  });

  it("announces a committed people change once, the way a consent mutation is announced", () => {
    render(<RequestReviewStepBridge />);
    const seen: unknown[] = [];
    const onChanged = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onChanged);
    const store = useVoiceSessionStore.getState();
    const result = { status: "sent", ui_refresh: ["connections", "location_people"], request_id: REQUEST };
    act(() => {
      store.emitToolResult("invite_person", result);
      store.emitPendingResolved("pa-1", "executed", result); // the relay's second frame for the same action
      store.emitToolResult("invite_person", { status: "confirmation_required", ui_refresh: [] });
      store.emitToolResult("invite_person", { status: "already_pending", ui_refresh: ["connections"] });
      store.emitToolResult("accept_connection_request", { status: "scope_review_required", ui_refresh: [] });
    });
    window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onChanged);
    expect(seen).toEqual([
      { source: "one_voice", reconcile: true, tool: "invite_person", status: "sent" },
    ]);
  });

  it("ignores steps of other kinds", () => {
    render(<RequestReviewStepBridge />);
    const report = vi.fn();
    act(() => {
      useVoiceSessionStore.getState().emitClientStep(
        { stepId: "step-5", kind: "open_share_sheet", payload: {}, timeoutS: 60 },
        report,
      );
    });
    expect(mocks.requestInternalAppNavigation).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
});
