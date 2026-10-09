"use client";

/** Keeps a reviewed mail draft alive across voice dock and route changes. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "@/components/icons";

import {
  EmailDraftCard,
  type SourceBoundEmailReplyAdapter,
} from "@/components/agent/email-draft-card";
import { richEmailPlainText } from "@/components/agent/email-rich-text";
import { useOptionalVoiceSession } from "@/components/one-voice/voice-session-provider";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import {
  parseMailDeliveryRef,
  parseMailDraftBinding,
  parseMailDraftOutcome,
  parseOpenMailDraftStepPayload,
  parseReviewedMailDraftStep,
  type MailDraftBinding,
  type ReviewedMailDraftStep,
} from "@/lib/one-voice/mail-draft-step";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import {
  EmailDeliveryError,
  EmailDeliveryService,
  type EmailDraft,
} from "@/lib/services/email-delivery-service";
import { useVault } from "@/lib/vault/vault-context";

/**
 * A reply in an email's own thread. The server derived the envelope from that
 * email; the card shows it locked, and every Send re-derives it from the ref.
 */
type ReplyBinding = { sourceMailRef: string; envelope: { to: string; subject: string } };
type OpenMailDraft = {
  id: string;
  ownerUid: string;
  draft: EmailDraft;
  recipientName: string;
  verbatimInitialBody: boolean;
  reply: ReplyBinding | null;
  /** Correlates this card's Send with the voice session that opened it. */
  deliveryRef: string | null;
  binding?: MailDraftBinding | null;
  review?: ReviewedMailDraftStep | null;
  invalidated?: boolean;
  reviewError?: string | null;
  recoveryCode?: string | null;
};
type MailDelivery = {
  id: string;
  ownerUid: string;
  draft: EmailDraft;
  recipientName: string;
  verbatimInitialBody: boolean;
  reply: ReplyBinding | null;
  deliveryRef: string | null;
  status: "sending" | "sent" | "failed" | "outcome_unknown" | "cancelled";
  error: string | null;
  binding?: MailDraftBinding | null;
  review?: ReviewedMailDraftStep | null;
};
/** A Send in flight: the card it came from and the action it prepared. */
type DeliveryAttempt = { deliveryRef: string | null; actionId: string | null };
/**
 * Failures that happened at Gmail, or may have: One is told about these. A
 * refusal before the send (a changed original, an expired review, a locked
 * vault) sent nothing, the card already says why, and One stays quiet rather
 * than contradict it with "I couldn't confirm".
 */
const REACHED_GMAIL = new Set(["EMAIL_ACTION_OUTCOME_UNKNOWN", "GMAIL_SEND_FAILED", "DELIVERY_FAILED"]);
type StepReport = (status: "ok" | "failed", payload?: Record<string, unknown>) => void;
type Viewport = { top: number; left: number; width: number; height: number };

function visibleViewport(): Viewport {
  const viewport = window.visualViewport;
  return viewport
    ? { top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height }
    : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
}

function newAttemptId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function reviewRecovery(reasonCode: string | null) {
  switch (reasonCode) {
    case "GMAIL_SEND_DISABLED": return { message: "Turn on Gmail sending to continue. Your draft is still here.", action: "Enable sending" };
    case "GMAIL_NOT_CONNECTED": return { message: "Connect Gmail to send this email. Your draft is still here.", action: "Connect Gmail" };
    case "GMAIL_SEND_PERMISSION_REQUIRED":
    case "GMAIL_RECONNECT_REQUIRED": return { message: "Reconnect Gmail and allow sending, then review this draft again.", action: "Reconnect Gmail" };
    case "GMAIL_SENDER_CHANGED": return { message: "The sending account changed. Review this draft again.", action: null };
    case "RECIPIENT_LOOKUP_UNAVAILABLE": return { message: "Recipients could not be checked. Nothing was sent. Review this draft again.", action: null };
    default: return { message: "Check the recipients, subject, and message to continue.", action: null };
  }
}

export function OneVoiceMailDraftBridge() {
  const { user } = useAuth();
  const voice = useOptionalVoiceSession();
  const { isVaultUnlocked, tokenExpiresAt, getVaultOwnerToken } = useVault();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [mailDraft, setMailDraft] = useState<OpenMailDraft | null>(null);
  const [mailDelivery, setMailDelivery] = useState<MailDelivery | null>(null);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const draftRef = useRef<OpenMailDraft | null>(null);
  const reportsRef = useRef(new Map<string, StepReport>());
  const handledStepsRef = useRef(new Set<string>());
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const ownerRef = useRef(user?.uid ?? null);
  const wasVaultUnlockedRef = useRef(isVaultUnlocked);
  // Keyed by attempt, so a slow Send that finishes after a newer one started is
  // still reported with its own action, and never lends it to the newer one.
  const attemptsRef = useRef(new Map<string, DeliveryAttempt>());
  const closedDraftsRef = useRef(new Set<string>());
  const deliveryRef = useRef<MailDelivery | null>(null);
  const voiceRef = useRef(voice);
  useLayoutEffect(() => { deliveryRef.current = mailDelivery; }, [mailDelivery]);
  useLayoutEffect(() => { voiceRef.current = voice; }, [voice]);
  const editsRef = useRef<{
    version: number;
    latest: EmailDraft | null;
    inFlight: { operationId: string; version: number } | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ version: 0, latest: null, inFlight: null, timer: null });

  const submitLatestEdit = useCallback(() => {
    const current = draftRef.current;
    const edits = editsRef.current;
    if (!current?.binding || !edits.latest || edits.inFlight || closedDraftsRef.current.has(current.binding.draftRef)) return;
    const operationId = newAttemptId();
    const draft = edits.latest;
    const plainBody = draft.body.trim().startsWith("<") && draft.body.includes(">") ? richEmailPlainText(draft.body) : draft.body;
    if (Array.from(draft.subject).length > 256 || Array.from(plainBody).length > 4000 ||
        [draft.to, draft.cc, draft.bcc].some((field) => Array.from(field ?? "").length > 16000)) {
      setMailDraft((shown) => shown?.id === current.id ? { ...shown,
        reviewError: "Shorten the draft to continue. The subject allows 256 characters and the message allows 4,000." } : shown);
      return;
    }
    edits.inFlight = { operationId, version: edits.version };
    const sent = voiceRef.current?.reportMailDraftChange?.({
      draft_ref: current.binding.draftRef, revision: current.binding.revision, operation_id: operationId,
      draft: { to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: plainBody },
    });
    if (!sent) {
      edits.inFlight = null;
      setMailDraft((shown) => shown?.id === current.id ? { ...shown, reviewError: "Reconnect to voice to review these changes." } : shown);
    }
  }, []);

  const revokeReview = useCallback((closed: boolean, draft?: EmailDraft) => {
    const current = draftRef.current ?? (deliveryRef.current?.status === "sending" ? deliveryRef.current : null);
    if (!current?.binding) return;
    const binding = current.binding;
    if (draftRef.current) draftRef.current = { ...draftRef.current, invalidated: true, ...(draft ? { draft } : {}) };
    setMailDraft((shown) => shown?.id === current.id ? { ...shown, invalidated: true, reviewError: null } : shown);
    const edits = editsRef.current;
    if (edits.timer) clearTimeout(edits.timer);
    if (closed) {
      closedDraftsRef.current.add(binding.draftRef);
      edits.latest = null;
      edits.inFlight = null;
    } else if (draft) {
      edits.latest = draft;
      edits.version += 1;
      edits.timer = setTimeout(submitLatestEdit, 250);
    }
    // Invalidate on the first keystroke; only complete snapshots advance the
    // server revision. One request at a time keeps later typing on that revision.
    voiceRef.current?.reportMailDraftChange?.({
      draft_ref: binding.draftRef,
      revision: binding.revision,
      operation_id: newAttemptId(),
      ...(closed ? { closed: true } : {}),
    });
  }, [submitLatestEdit]);

  useEffect(() => {
    setHost(document.body);
    const updateViewport = () => setViewport(visibleViewport());
    updateViewport();
    window.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, []);

  useVoiceToolEffects({
    onClientStep: (step, report) => {
      if (step.kind === "mail_draft_outcome") {
        const outcome = parseMailDraftOutcome(step.payload);
        const current = draftRef.current ?? deliveryRef.current;
        if (outcome?.status === "cancelled") {
          // Cancellation is a terminal client-side state. Clear every pending
          // edit before closing the card so a late edit response cannot
          // resurrect a draft that the user explicitly cancelled.
          const edits = editsRef.current;
          if (!outcome || !current?.binding || current.ownerUid !== user?.uid ||
              closedDraftsRef.current.has(outcome.draftRef) ||
              current.binding.draftRef !== outcome.draftRef ||
              current.binding.revision !== outcome.revision) {
            report("failed", { reason: "stale_review" });
            return;
          }
          if (edits.timer) clearTimeout(edits.timer);
          edits.timer = null;
          edits.latest = null;
          edits.inFlight = null;
          closedDraftsRef.current.add(outcome.draftRef);
          const next: MailDelivery = {
            ...current, id: `voice:cancelled:${outcome.draftRef}:${outcome.revision}`,
            status: "cancelled", error: null,
          };
          deliveryRef.current = next;
          draftRef.current = null;
          setMailDraft(null);
          setMailDelivery(next);
          report("ok", { draft_ref: outcome.draftRef, revision: outcome.revision, action_id: outcome.actionId });
          return;
        }
        if (outcome?.status === "needs_input") {
          if (outcome.reasonCode === "VOICE_APPROVAL_SUPERSEDED" && current?.binding &&
              current.ownerUid === user?.uid && !closedDraftsRef.current.has(outcome.draftRef) &&
              current.binding.draftRef === outcome.draftRef && current.binding.revision === outcome.revision &&
              outcome.actionId !== null && current.review?.actionId === outcome.actionId) {
            const next: OpenMailDraft = { ...current, review: null, invalidated: true, recoveryCode: null,
              reviewError: "Review the current email again. Nothing was sent." };
            draftRef.current = next;
            deliveryRef.current = null;
            setMailDelivery(null);
            setMailDraft(next);
            report("ok", { draft_ref: outcome.draftRef, revision: outcome.revision, action_id: outcome.actionId });
            return;
          }
          const pending = editsRef.current.inFlight;
          if (!current?.binding || current.ownerUid !== user?.uid || closedDraftsRef.current.has(outcome.draftRef) ||
              current.binding.draftRef !== outcome.draftRef || !pending || pending.operationId !== outcome.operationId ||
              outcome.revision < current.binding.revision || !draftRef.current) {
            report("failed", { reason: "stale_review" }); return;
          }
          const newerEdits = editsRef.current.version > pending.version;
          editsRef.current.inFlight = null;
          const next = { ...draftRef.current, binding: { draftRef: outcome.draftRef, revision: outcome.revision },
            review: null, invalidated: true, recoveryCode: outcome.reasonCode, reviewError: reviewRecovery(outcome.reasonCode).message };
          draftRef.current = next;
          setMailDraft(next);
          report("ok", { draft_ref: outcome.draftRef, revision: outcome.revision });
          if (newerEdits) submitLatestEdit();
          return;
        }
        if (!outcome || !current?.binding || current.ownerUid !== user?.uid ||
            current.binding.draftRef !== outcome.draftRef || current.binding.revision !== outcome.revision ||
            current.review?.actionId !== outcome.actionId) {
          report("failed", { reason: "stale_review" });
          return;
        }
        const next: MailDelivery = {
          ...current, id: `voice:${outcome.actionId}`, status: outcome.status, error: null,
        };
        deliveryRef.current = next;
        setMailDelivery(next);
        draftRef.current = null;
        setMailDraft(null);
        report("ok", { draft_ref: outcome.draftRef, revision: outcome.revision, action_id: outcome.actionId });
        return;
      }
      if (step.kind === "review_mail_draft") {
        if (handledStepsRef.current.has(step.stepId)) return;
        handledStepsRef.current.add(step.stepId);
        const review = parseReviewedMailDraftStep(step.payload);
        const activeDelivery = deliveryRef.current;
        const current = draftRef.current;
        if (!review) { report("failed", { reason: "invalid_mail_draft" }); return; }
        if (!user?.uid || !isVaultUnlocked || document.visibilityState !== "visible") {
          report("failed", { reason: !user?.uid ? "owner_unavailable" : !isVaultUnlocked ? "vault_locked" : "surface_backgrounded" });
          return;
        }
        const edits = editsRef.current;
        const pending = edits.inFlight;
        const previous = current ?? activeDelivery;
        const isRetiredSendRecovery = !review.ready && review.operationId === null &&
          review.previousActionId !== null && review.previousRevision !== null &&
          previous?.ownerUid === user.uid && previous.binding?.draftRef === review.draftRef &&
          previous.binding.revision === review.previousRevision &&
          previous.review?.actionId === review.previousActionId &&
          review.revision > previous.binding.revision && pending === null && edits.latest === null &&
          (!activeDelivery || ["sending", "failed"].includes(activeDelivery.status));
        if (review.previousActionId !== null && !isRetiredSendRecovery) {
          report("failed", { reason: "stale_review" }); return;
        }
        // Once the card has handed its reviewed action to the delivery layer,
        // a new voice review must not replace the in-flight delivery surface.
        // The next review can be accepted after the delivery reaches a
        // terminal state and the server issues a newer binding.
        if (activeDelivery?.status === "sending" && !isRetiredSendRecovery) {
          report("failed", { reason: "stale_review" });
          return;
        }
        const isVoiceRecovery = review.operationId === null &&
          current?.invalidated === true &&
          current.binding?.draftRef === review.draftRef &&
          review.revision > (current.binding?.revision ?? 0) &&
          pending === null &&
          edits.latest === null;
        if (current?.binding?.draftRef === review.draftRef && pending) {
          if (pending.operationId !== review.operationId || review.revision <= current.binding.revision) {
            report("failed", { reason: "stale_review" }); return;
          }
          edits.inFlight = null;
          if (edits.version > pending.version) {
            const next = { ...current, binding: { draftRef: review.draftRef, revision: review.revision }, review: null, invalidated: true };
            draftRef.current = next;
            setMailDraft(next);
            report("failed", { reason: "superseded_edit" });
            submitLatestEdit();
            return;
          }
        } else if (review.operationId ||
          (current?.invalidated && current.binding?.draftRef === review.draftRef && !isVoiceRecovery && !isRetiredSendRecovery)) {
          report("failed", { reason: "stale_review" }); return;
        }
        if (closedDraftsRef.current.has(review.draftRef) || (review.ready && Date.parse(review.expiresAt) <= Date.now()) ||
            (current && (current.binding?.draftRef !== review.draftRef ||
              current.binding.revision > review.revision ||
              (current.binding.revision === review.revision && (current.invalidated || Boolean(current.review)))))) {
          report("failed", { reason: "stale_review" }); return;
        }
        const next: OpenMailDraft = {
          id: `${review.draftRef}:${review.revision}`, ownerUid: user.uid,
          draft: review.draft, recipientName: review.draft.to || "selected recipients",
          verbatimInitialBody: true, reply: null, deliveryRef: review.deliveryRef,
          binding: { draftRef: review.draftRef, revision: review.revision }, review, invalidated: false,
          reviewError: review.ready ? null : reviewRecovery(review.reasonCode).message,
          recoveryCode: review.reasonCode,
        };
        if (edits.timer) clearTimeout(edits.timer);
        edits.latest = null;
        edits.inFlight = null;
        previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        draftRef.current = next;
        deliveryRef.current = null;
        reportsRef.current.set(next.id, report);
        setMailDelivery(null);
        setMailDraft(next);
        return;
      }
      if (step.kind !== "open_mail_draft" || handledStepsRef.current.has(step.stepId)) return;
      handledStepsRef.current.add(step.stepId);
      const parsed = parseOpenMailDraftStepPayload(step.payload);
      if (!parsed) {
        report("failed", { reason: "invalid_mail_draft" });
        return;
      }
      if (!user?.uid) {
        report("failed", { reason: "owner_unavailable" });
        return;
      }
      if (!isVaultUnlocked) {
        report("failed", { reason: "vault_locked" });
        setVaultDialogOpen(true);
        return;
      }
      if (draftRef.current) {
        report("failed", { reason: "draft_already_open" });
        return;
      }
      const next: OpenMailDraft = {
        id: step.stepId,
        ownerUid: user.uid,
        recipientName: parsed.toName,
        verbatimInitialBody: true,
        draft: { to: parsed.to, cc: "", bcc: "", subject: parsed.subject, body: parsed.body },
        reply: parsed.mode === "reply" && parsed.sourceMailRef
          ? {
              sourceMailRef: parsed.sourceMailRef,
              envelope: { to: parsed.to, subject: parsed.subject },
            }
          : null,
        deliveryRef: parseMailDeliveryRef(step.payload),
        binding: parseMailDraftBinding(step.payload),
      };
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      draftRef.current = next;
      reportsRef.current.set(step.stepId, report);
      setMailDelivery(null);
      setMailDraft(next);
    },
  });

  // A step succeeds only after the body portal and review card commit.
  useEffect(() => {
    if (!mailDraft || !host || !isVaultUnlocked || mailDraft.ownerUid !== user?.uid) return;
    const report = reportsRef.current.get(mailDraft.id);
    if (!report) return;
    reportsRef.current.delete(mailDraft.id);
    const mounted = Boolean(surfaceRef.current?.querySelector('[data-testid="one-email-draft-card"]')) &&
      (!mailDraft.binding || document.visibilityState === "visible") && !mailDraft.invalidated;
    if (mounted) surfaceRef.current?.focus({ preventScroll: true });
    report(mounted ? "ok" : "failed", mounted ? {
      mounted: true,
      ...(mailDraft.review?.ready ? {
        draft_ref: mailDraft.review.draftRef, revision: mailDraft.review.revision, action_id: mailDraft.review.actionId,
      } : mailDraft.binding ? { draft_ref: mailDraft.binding.draftRef, revision: mailDraft.binding.revision } : {}),
    } : { reason: "draft_not_mounted" });
    if (!mounted) {
      draftRef.current = null;
      setMailDraft(null);
    }
  }, [host, isVaultUnlocked, mailDraft, user?.uid]);

  useEffect(() => {
    const reports = reportsRef.current;
    return () => {
      revokeReview(true);
      for (const report of reports.values()) report("failed", { reason: "surface_unmounted" });
      reports.clear();
    };
  }, [revokeReview]);

  useEffect(() => {
    if (ownerRef.current === (user?.uid ?? null)) return;
    revokeReview(true);
    ownerRef.current = user?.uid ?? null;
    for (const report of reportsRef.current.values()) report("failed", { reason: "owner_changed" });
    reportsRef.current.clear();
    // A previous owner's Send is never reported into the next owner's session.
    attemptsRef.current.clear();
    handledStepsRef.current.clear();
    draftRef.current = null;
    setMailDraft(null);
    setMailDelivery(null);
    setVaultDialogOpen(false);
  }, [revokeReview, user?.uid]);

  useEffect(() => {
    const wasUnlocked = wasVaultUnlockedRef.current;
    wasVaultUnlockedRef.current = isVaultUnlocked;
    if (!wasUnlocked || isVaultUnlocked) return;
    revokeReview(true);
    for (const report of reportsRef.current.values()) report("failed", { reason: "vault_locked" });
    reportsRef.current.clear();
    handledStepsRef.current.clear();
    draftRef.current = null;
    setMailDraft(null);
    setMailDelivery(null);
    setVaultDialogOpen(false);
  }, [isVaultUnlocked, revokeReview]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") revokeReview(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [revokeReview]);

  const getMailAuth = useCallback(async () => {
    if (!user || !isVaultUnlocked || (tokenExpiresAt && Date.now() >= tokenExpiresAt)) return null;
    const vaultOwnerToken = getVaultOwnerToken();
    if (!vaultOwnerToken) return null;
    const firebaseIdToken = await user.getIdToken();
    return firebaseIdToken ? { firebaseIdToken, vaultOwnerToken } : null;
  }, [getVaultOwnerToken, isVaultUnlocked, tokenExpiresAt, user]);

  const dismissDraft = () => {
    revokeReview(true);
    draftRef.current = null;
    setMailDraft(null);
    const previousFocus = previousFocusRef.current;
    if (previousFocus?.isConnected) window.requestAnimationFrame(() => previousFocus.focus());
  };

  const onMailSendStarted = (reviewedDraft: EmailDraft): string => {
    const id = newAttemptId();
    const openDraft = draftRef.current;
    attemptsRef.current.set(id, { deliveryRef: openDraft?.deliveryRef ?? null, actionId: null });
    const next: MailDelivery = {
      id,
      ownerUid: openDraft?.ownerUid ?? user?.uid ?? "",
      draft: reviewedDraft,
      recipientName: openDraft?.recipientName ?? "",
      verbatimInitialBody: Boolean(openDraft?.verbatimInitialBody && reviewedDraft.body === openDraft.draft.body),
      reply: openDraft?.reply ?? null,
      deliveryRef: openDraft?.deliveryRef ?? null,
      binding: openDraft?.binding,
      review: openDraft?.review,
      status: "sending",
      error: null,
    };
    deliveryRef.current = next;
    setMailDelivery(next);
    draftRef.current = null;
    setMailDraft(null);
    return id;
  };

  const onDeliveryPrepared = (actionId: string, attemptId: string | null) => {
    const attempt = attemptId ? attemptsRef.current.get(attemptId) : undefined;
    if (attempt) attempt.actionId = actionId;
  };

  // Tell the voice session the Send finished, so One can say what happened.
  // Only the send action is named; the relay reads its outcome server-side.
  // Nothing here depends on the socket: the card already shows the outcome.
  const reportDelivery = (id: string | null | undefined, reachedGmail: boolean) => {
    const attempt = id ? attemptsRef.current.get(id) : undefined;
    if (!id || !attempt) return;
    attemptsRef.current.delete(id);
    if (reachedGmail && attempt.deliveryRef && attempt.actionId) {
      voice?.reportMailDelivery?.(attempt.deliveryRef, attempt.actionId);
    }
  };

  const onMailSent = (id?: string | null) => {
    setMailDelivery((current) => current && current.id === id ? { ...current, status: "sent", error: null } : current);
    reportDelivery(id, true);
  };

  const onMailSendFailed = (error: EmailDeliveryError, id?: string | null) => {
    setMailDelivery((current) => current && current.id === id
      ? {
          ...current,
          status: error.code === "EMAIL_ACTION_OUTCOME_UNKNOWN" ? "outcome_unknown" : "failed",
          error: error.message,
        }
      : current);
    reportDelivery(id, REACHED_GMAIL.has(error.code ?? ""));
  };

  const reopenFailedDraft = () => {
    if (!mailDelivery || mailDelivery.status !== "failed") return;
    // A reply reopens still bound to its original email, so Send stays in
    // that thread; dropping the binding here would send a new, unthreaded one.
    const next: OpenMailDraft = {
      id: newAttemptId(),
      ownerUid: mailDelivery.ownerUid,
      draft: mailDelivery.draft,
      recipientName: mailDelivery.recipientName,
      verbatimInitialBody: mailDelivery.verbatimInitialBody,
      reply: mailDelivery.reply,
      deliveryRef: mailDelivery.deliveryRef,
      binding: mailDelivery.binding,
      review: null,
      invalidated: Boolean(mailDelivery.binding),
    };
    draftRef.current = next;
    setMailDraft(next);
    setMailDelivery(null);
  };

  const visibleDraft = isVaultUnlocked && mailDraft?.ownerUid === user?.uid ? mailDraft : null;
  const visibleDelivery = isVaultUnlocked && mailDelivery?.ownerUid === user?.uid ? mailDelivery : null;
  const visible = visibleDraft || visibleDelivery;
  const replySourceRef = visibleDraft?.reply?.sourceMailRef ?? null;
  const replyAdapter = useMemo<SourceBoundEmailReplyAdapter | null>(
    () =>
      replySourceRef
        ? {
            reportsSendStart: true,
            send: async ({
              firebaseIdToken,
              vaultOwnerToken,
              draft,
              idempotencyKey,
              onSendRequestStarted,
              onPrepared,
            }) => {
              // Only the body is the person's. Recipient, subject and thread are
              // re-derived by the server from the ref on prepare and on send, so
              // the locked envelope fields are not sent at all. The body goes as
              // reviewed: no reformatting of dictated text.
              // Dictated text stays exactly as reviewed; an edit made in the rich
              // editor arrives as markup, and its plain-text part must be text.
              const edited = draft.body.trim().startsWith("<") && draft.body.includes(">");
              const bound: EmailDraft = {
                to: "",
                cc: "",
                bcc: "",
                subject: "",
                body: edited ? richEmailPlainText(draft.body) : draft.body,
                htmlBody: draft.htmlBody,
                sourceMailRef: replySourceRef,
              };
              const auth = { firebaseIdToken, vaultOwnerToken };
              const prepared = await EmailDeliveryService.prepare({ ...auth, draft: bound, idempotencyKey });
              if (!prepared.actionId) {
                throw new EmailDeliveryError("The reply could not be prepared for sending.", 500);
              }
              onPrepared?.(prepared.actionId);
              onSendRequestStarted?.();
              const sent = await EmailDeliveryService.send({ ...auth, actionId: prepared.actionId, draft: bound, senderToken: prepared.senderToken });
              return { outcomeUnknown: sent.outcomeUnknown };
            },
          }
        : null,
    [replySourceRef],
  );
  const deliveryIsReply = Boolean(visibleDelivery?.reply);
  return (
    <>
      {host && visible ? createPortal(
        <div
          data-testid="one-voice-mail-portal"
          className="pointer-events-none fixed z-[700] flex items-end justify-center px-3 py-3 sm:px-6"
          style={viewport ? {
            top: viewport.top,
            left: viewport.left,
            width: viewport.width,
            height: viewport.height,
          } : { inset: 0 }}
        >
          {visibleDraft ? (
            <div
              ref={surfaceRef}
              data-testid="one-voice-mail-draft-surface"
              role="region"
              aria-label={`Mail draft for ${visibleDraft.recipientName}`}
              tabIndex={-1}
              className="pointer-events-auto max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl bg-card p-2 shadow-2xl outline-none"
            >
              <EmailDraftCard
                key={visibleDraft.id}
                initialInstruction=""
                initialDraft={visibleDraft.draft}
                verbatimInitialBody={visibleDraft.verbatimInitialBody}
                getAuth={getMailAuth}
                onRequireVault={() => setVaultDialogOpen(true)}
                onDismiss={dismissDraft}
                onSendStarted={onMailSendStarted}
                onSent={onMailSent}
                onSendFailed={onMailSendFailed}
                onDeliveryPrepared={onDeliveryPrepared}
                reviewedSend={visibleDraft.review?.ready ? visibleDraft.review : null}
                canSendReviewed={() => Boolean(visibleDraft.binding && !closedDraftsRef.current.has(visibleDraft.binding.draftRef) &&
                  ownerRef.current === visibleDraft.ownerUid && wasVaultUnlockedRef.current && document.visibilityState === "visible")}
                sendUnavailable={Boolean(visibleDraft.binding && (!visibleDraft.review?.ready || visibleDraft.invalidated))}
                onDraftEdit={visibleDraft.binding ? (draft) => revokeReview(false, draft) : undefined}
                sourceBoundReply={replyAdapter}
                sourceBoundEnvelope={visibleDraft.reply?.envelope ?? null}
              />
              {visibleDraft.reviewError ? (
                <div role="status" className="flex flex-wrap items-center gap-2 px-3 pb-2 text-sm text-muted-foreground">
                  <span>{visibleDraft.reviewError}</span>
                  {reviewRecovery(visibleDraft.recoveryCode ?? null).action ? (
                    <a className="font-medium text-primary underline" href="/one/gmail">{reviewRecovery(visibleDraft.recoveryCode ?? null).action}</a>
                  ) : null}
                  <button type="button" className="font-medium text-primary underline" onClick={() => revokeReview(false, draftRef.current?.draft)}>Review again</button>
                </div>
              ) : null}
            </div>
          ) : null}
          {visibleDelivery ? (
            <div
              data-testid="one-voice-mail-delivery"
              role="status"
              aria-live="polite"
              className="pointer-events-auto flex h-fit w-full max-w-2xl items-center gap-3 rounded-2xl bg-card px-4 py-3 text-sm shadow-2xl"
            >
              <span className="min-w-0 flex-1">
                {visibleDelivery.status === "sending" ? (deliveryIsReply ? "Sending reply…" : "Sending mail…") :
                  visibleDelivery.status === "sent" ? (deliveryIsReply ? "Reply sent in the original thread." : "Mail sent.") :
                    visibleDelivery.status === "cancelled" ? "Mail cancelled." :
                    visibleDelivery.status === "outcome_unknown" ? "Delivery could not be confirmed. Check Sent Mail before trying again." :
                      visibleDelivery.error || (deliveryIsReply ? "The reply could not be sent." : "Mail could not be sent.")}
              </span>
              {visibleDelivery.status === "failed" && !visibleDelivery.binding ? (
                <button type="button" className="shrink-0 font-semibold text-[color:var(--app-accent)]" onClick={reopenFailedDraft}>
                  Review draft
                </button>
              ) : null}
              <button type="button" aria-label="Dismiss mail status" onClick={() => setMailDelivery(null)}>
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : null}
        </div>,
        host,
      ) : null}
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={setVaultDialogOpen}
          onSuccess={() => setVaultDialogOpen(false)}
          title="Unlock vault to send mail"
          description={mailDraft || mailDelivery
            ? "Unlock your vault, then review the draft and tap Send again."
            : "Unlock your vault, then ask One to draft the mail again."}
          allowVaultCreation={false}
        />
      ) : null}
    </>
  );
}
