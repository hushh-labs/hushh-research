"use client";

/**
 * Runs the `open_request_review` client step for One Voice.
 *
 * A connection request that carries information scopes cannot be accepted by
 * voice: only the Consent Center's review screen lets the person choose the
 * scopes. The relay sends this step; this bridge opens that screen for the
 * exact request, then tells the relay when the screen finished (the Consent
 * Center's own completion event) or when the person left it. The report is
 * only "the screen closed": the relay re-reads the request and the
 * relationship and narrates what actually happened. Nothing here writes.
 */

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  dispatchConsentStateChanged,
} from "@/lib/consent/consent-events";
import { ROUTES } from "@/lib/navigation/routes";
import {
  isPeopleGraphChange,
  VoiceRefreshDeduper,
} from "@/lib/one-voice/people-voice-refresh";
import type { ToolResultPublic } from "@/lib/one-voice/protocol";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

export const OPEN_REQUEST_REVIEW_STEP = "open_request_review" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Report = (
  status: "ok" | "failed",
  payload?: Record<string, unknown>,
) => void;

type InFlight = { requestId: string; report: Report; cleanup: () => void };

export function requestReviewHref(requestId: string): string {
  return buildConsentCenterHref("pending", { requestId, from: "voice" });
}

export function RequestReviewStepBridge() {
  const pathname = usePathname();
  const inFlightRef = useRef<Map<string, InFlight>>(new Map());
  const handledRef = useRef<Set<string>>(new Set());
  const onConsentRef = useRef(false);

  // Leaving the Consent Center without the completion event is "left": the
  // relay re-reads and finds the request still pending (or not).
  useEffect(() => {
    const onConsent = Boolean(pathname && pathname.startsWith(ROUTES.CONSENTS));
    if (onConsentRef.current && !onConsent) {
      for (const [stepId, entry] of inFlightRef.current) {
        entry.cleanup();
        inFlightRef.current.delete(stepId);
        entry.report("ok", { outcome: "left", request_id: entry.requestId });
      }
    }
    onConsentRef.current = onConsent;
  }, [pathname]);

  useEffect(() => {
    const inFlight = inFlightRef.current;
    return () => {
      for (const entry of inFlight.values()) entry.cleanup();
      inFlight.clear();
    };
  }, []);

  // A committed people change by voice (sent / accepted / declined /
  // cancelled / removed) is announced the way a consent mutation is, so the
  // Connect lists, the pending count and the Consent Center refetch through
  // their existing listeners. The relay sends two frames for one confirmed
  // action; they collapse to one announcement. Nothing here writes.
  const refreshDedupe = useRef(new VoiceRefreshDeduper());
  const announce = (tool: string | null, result: ToolResultPublic | null) => {
    if (!isPeopleGraphChange(tool, result)) return;
    if (!refreshDedupe.current.shouldRefresh(result)) return;
    dispatchConsentStateChanged({
      source: "one_voice",
      reconcile: true,
      tool: tool ?? undefined,
      status: result?.status,
    });
  };

  useVoiceToolEffects({
    onToolResult: (tool, result) => announce(tool, result),
    onPendingResolved: (_id, status, result) => {
      if (status !== "executed") return;
      announce(null, result);
    },
    onClientStep: (step, report) => {
      if (step.kind !== OPEN_REQUEST_REVIEW_STEP) return;
      if (handledRef.current.has(step.stepId)) return;
      handledRef.current.add(step.stepId);
      const requestId = String(step.payload?.request_id ?? "").trim();
      if (!UUID.test(requestId)) {
        report("failed", { outcome: "failed", reason: "invalid_request_id" });
        return;
      }
      let reported = false;
      const once: Report = (status, payload) => {
        if (reported) return;
        reported = true;
        report(status, payload);
      };
      const onComplete = () => {
        entry.cleanup();
        inFlightRef.current.delete(step.stepId);
        once("ok", { outcome: "handled", request_id: requestId });
      };
      const entry: InFlight = {
        requestId,
        report: once,
        cleanup: () => {
          window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, onComplete);
        },
      };
      window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, onComplete);
      inFlightRef.current.set(step.stepId, entry);
      const navigated = requestInternalAppNavigation({
        href: requestReviewHref(requestId),
        source: "voice",
        transitionMode: "contextual",
      });
      if (!navigated) {
        entry.cleanup();
        inFlightRef.current.delete(step.stepId);
        once("failed", { outcome: "failed", reason: "navigation_unavailable", request_id: requestId });
        return;
      }
      onConsentRef.current = true;
    },
  });

  return null;
}
