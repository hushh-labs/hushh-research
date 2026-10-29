"use client";

import { useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { isProductActivityScopeCurrent, snapshotProductActivityScope } from "@/lib/observability/product-activity-scope";
import { trackEvent } from "@/lib/observability/client";
import type { CountBucket } from "@/lib/observability/events";
import type { LiveActivityConsolidationTelemetryOutcome } from "@/lib/observability/live-activity-telemetry";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";
import { liveActivitySectionSubject, recordCurrentSectionVisit } from "@/components/observability/live-activity-section-subject";
import {
  loadAgentPkmAutoSavePolicy,
  subscribeAgentPkmAutoSavePolicyInvalidation,
} from "@/lib/agent/agent-pkm-auto-save-policy";
import {
  attachLiveActivityStore,
  hasSeenLiveActivityNotice,
  markLiveActivityNoticeSeen,
  peekLiveActivity,
  setLiveActivityEnabled,
} from "@/lib/pkm/live-activity/live-activity-journal";
import {
  consolidateLiveActivity,
  shouldConsolidateLiveActivity,
  type LiveActivityConsolidationOutcome,
} from "@/lib/pkm/live-activity/live-activity-consolidation";
import { LIVE_ACTIVITY_COALESCE_WINDOW_MS } from "@/lib/pkm/live-activity/live-activity-types";
import { morphyToast } from "@/lib/morphy-ux/toast-utils";

const NOTICE = "One now remembers useful things you do in the app.";
const CHECK_INTERVAL_MS = 60_000;
// Busy, skipped and cancelled runs reached no decision, so they are not reported.
const REPORTED_OUTCOMES: ReadonlySet<LiveActivityConsolidationOutcome> = new Set(["saved", "nothing_durable", "host_skipped", "failed", "memory_full"]);
// Retried after the gap: the run never got to look at the batch.
const RETRY_OUTCOMES: ReadonlySet<LiveActivityConsolidationOutcome> = new Set(["cancelled", "busy"]);
// Nothing changes on its own, so these wait for new activity or the next unlock.
const BLOCKED_OUTCOMES: ReadonlySet<LiveActivityConsolidationOutcome> = new Set(["failed", "memory_full"]);
const noticeShownThisSession = new Set<string>();

/** Once per owner per device; without storage, at most once per session. */
function showNoticeOnce(userId: string): void {
  if (noticeShownThisSession.has(userId)) return;
  noticeShownThisSession.add(userId);
  if (hasSeenLiveActivityNotice(userId)) return;
  markLiveActivityNoticeSeen(userId);
  morphyToast.info(NOTICE, { duration: 3000 });
}

function countBucket(count: number): CountBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2_5";
  return count <= 20 ? "6_20" : "gt_20";
}

/** One dedicated, enum-only event per consolidation cycle that reached a decision. */
function trackConsolidationOutcome(outcome: LiveActivityConsolidationOutcome, saved: number): void {
  if (!REPORTED_OUTCOMES.has(outcome)) return;
  trackEvent("live_activity_consolidation_completed", {
    outcome: outcome as LiveActivityConsolidationTelemetryOutcome,
    saved_bucket: countBucket(outcome === "saved" ? saved : 0),
  });
}

/**
 * The section open at unlock happened before the store attached, so the journal
 * dropped it. The shared visit dedupe keeps a re-attach in the same visit (lock
 * and unlock, a policy retry) from counting it again.
 */
function recordCurrentSection(userId: string): void {
  const subject = liveActivitySectionSubject(window.location.pathname);
  if (subject) recordCurrentSectionVisit(userId, subject);
}

function pendingStats(userId: string, seenThrough: number) {
  let pending = 0;
  let oldestPendingAt: number | null = null;
  for (const event of peekLiveActivity(userId)) {
    if (event.lastAt <= seenThrough) continue;
    pending += 1;
    oldestPendingAt = oldestPendingAt === null ? event.lastAt : Math.min(oldestPendingAt, event.lastAt);
  }
  return { pending, oldestPendingAt };
}

// The token renews in place (the journal follows via renewLiveActivitySession), so it is read per use.
type Session = { userId: string; vaultKey: string; vaultOwnerToken: () => string | null };

/** Starts capture and periodic consolidation for one unlocked owner session; returns cleanup. */
function startLiveActivitySession(session: Session): () => void {
  const { userId } = session;
  const scope = snapshotProductActivityScope();
  const controller = new AbortController();
  let stopped = false;
  let detach: (() => void) | null = null;
  let running = false;
  let lastRunAt: number | null = null;
  let seenThrough = 0;
  let firstCheck = true;
  let policyRead = 0;
  let policyPending = true;
  // An unreadable policy keeps capture off but is read again next check; an explicit "off" is not.
  let policyUnreadable = false;
  const isCurrent = () => !stopped && Boolean(scope && scope.owner.userId === userId &&
    isProductActivityScopeCurrent(scope));

  const check = () => {
    if (!isCurrent()) return;
    if (policyUnreadable && !policyPending) { void enableFromPolicy(); return; }
    const vaultOwnerToken = session.vaultOwnerToken();
    if (!detach || running || policyPending || !vaultOwnerToken) return;
    const now = Date.now();
    // A run belongs to one vault credential and one enabled attachment: lock,
    // rotation, renewal or turning automatic memory off cancels it.
    const epoch = snapshotVaultSessionEpoch();
    const attached = detach;
    const runIsCurrent = () => isCurrent() && detach === attached && isVaultSessionEpochCurrent(epoch);
    if (!shouldConsolidateLiveActivity({ ...pendingStats(userId, seenThrough), lastRunAt, now })) return;
    running = true;
    const reason = firstCheck ? "attach" : "interval";
    firstCheck = false;
    // A run cut off by the app hiding never judged its batch: cancel it, so it
    // is retried later instead of using up an attempt.
    const run = new AbortController();
    const cancel = () => run.abort();
    const cancelOnHide = () => { if (document.visibilityState === "hidden") cancel(); };
    document.addEventListener("visibilitychange", cancelOnHide);
    controller.signal.addEventListener("abort", cancel, { once: true });
    void consolidateLiveActivity({ userId, vaultKey: session.vaultKey, vaultOwnerToken, reason,
      isCurrent: runIsCurrent, signal: run.signal })
      .then(({ outcome, saved, more }) => {
        lastRunAt = now;
        // A stale or busy run, or one with another day still queued, retries after
        // the gap. A settled run marks what it saw as handled except repeats the
        // journal still holds back; a blocked run waits for new activity.
        if (!RETRY_OUTCOMES.has(outcome) && !more) {
          seenThrough = BLOCKED_OUTCOMES.has(outcome) ? now : now - LIVE_ACTIVITY_COALESCE_WINDOW_MS;
        }
        if (runIsCurrent() && !run.signal.aborted) trackConsolidationOutcome(outcome, saved);
      })
      .finally(() => {
        running = false;
        document.removeEventListener("visibilitychange", cancelOnHide);
        controller.signal.removeEventListener("abort", cancel);
      });
  };
  const disable = () => {
    detach?.();
    detach = null;
    setLiveActivityEnabled(userId, false);
  };
  const enableFromPolicy = async () => {
    const read = ++policyRead;
    policyPending = true;
    const vaultOwnerToken = session.vaultOwnerToken();
    const policy = vaultOwnerToken
      ? await loadAgentPkmAutoSavePolicy({ userId, vaultKey: session.vaultKey, vaultOwnerToken }).catch(() => null)
      : null;
    // Only the newest read decides, so a stale "enabled" never overrides a later "off".
    if (read !== policyRead || !isCurrent()) return;
    policyPending = false;
    policyUnreadable = policy === null;
    // The owner's automatic-memory choice gates capture; an unreadable choice fails closed.
    if (!policy?.enabled) { disable(); return; }
    showNoticeOnce(userId);
    setLiveActivityEnabled(userId, true);
    if (detach) return;
    detach = attachLiveActivityStore({ userId, vaultKey: session.vaultKey });
    recordCurrentSection(userId);
  };
  // Runs only while visible or on a desktop timer: a run started as the app
  // hides is often cut off by suspension, and the device log keeps the events.
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  const stopPolicyWatch = subscribeAgentPkmAutoSavePolicyInvalidation(userId, () => { void enableFromPolicy(); });
  void enableFromPolicy();
  return () => {
    stopped = true;
    controller.abort();
    clearInterval(timer);
    stopPolicyWatch();
    disable();
  };
}

/** Live activity runs only while the validated owner's vault is unlocked. */
export function LiveActivityBridge(): null {
  const { userId: ownerId } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const tokenRef = useRef(vaultOwnerToken);
  useEffect(() => { tokenRef.current = vaultOwnerToken; }, [vaultOwnerToken]);
  const hasToken = Boolean(vaultOwnerToken);
  // Owner transitions, lock and key rotation restart the session with fresh fences.
  const authGeneration = useSyncExternalStore(subscribeAuthSessionGeneration, getAuthSessionGeneration, () => null);
  // An account reset keeps the vault unlocked but stales the session scope, so it restarts too.
  const [ownerReset, bumpOwnerReset] = useReducer((count: number) => count + 1, 0);
  useEffect(() => subscribeDurableOwnerReset(() => bumpOwnerReset()), []);
  useEffect(() => {
    if (!ownerId || !isVaultUnlocked || !vaultKey || !hasToken) return;
    return startLiveActivitySession({ userId: ownerId, vaultKey, vaultOwnerToken: () => tokenRef.current });
  }, [ownerId, isVaultUnlocked, vaultKey, hasToken, authGeneration, ownerReset]);
  return null;
}
