"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Mail, Send, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EmailRichTextComposer,
  normalizeRichEmailText,
  richEmailHtmlFromMarkdown,
} from "@/components/agent/email-rich-text";
import {
  EmailDeliveryError,
  EmailDeliveryService,
  type EmailDraft,
} from "@/lib/services/email-delivery-service";

type EmailDraftCardProps = {
  initialInstruction: string;
  initialDraft?: EmailDraft | null;
  /** The person explicitly asked One to draft from a Gmail entry point. */
  autoDraft?: boolean;
  getAuth: () => Promise<{
    firebaseIdToken: string;
    vaultOwnerToken: string;
  } | null>;
  onRequireVault: () => void;
  onDismiss: () => void;
  /** Moves the reviewed draft into live, collapsible chat history immediately. */
  onSendStarted?: (draft: EmailDraft) => string | null | undefined;
  onSent: (attemptId?: string | null) => void;
  onSendFailed?: (error: EmailDeliveryError, attemptId?: string | null) => void;
};

const EMPTY_DRAFT: EmailDraft = {
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
};

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function EmailDraftCard({
  initialInstruction,
  initialDraft = null,
  autoDraft = false,
  getAuth,
  onRequireVault,
  onDismiss,
  onSendStarted,
  onSent,
  onSendFailed,
}: EmailDraftCardProps) {
  const idPrefix = useId();
  const [draft, setDraft] = useState<EmailDraft>(() => {
    const body = normalizeRichEmailText(
      initialDraft?.body ?? (autoDraft ? "" : initialInstruction),
    );
    return {
      ...EMPTY_DRAFT,
      ...(initialDraft ?? {}),
      body,
      htmlBody: richEmailHtmlFromMarkdown(body),
    };
  });
  const [showCcBcc, setShowCcBcc] = useState(() => Boolean(draft.cc || draft.bcc));
  const [missingDetails, setMissingDetails] = useState<string[]>([]);
  const [busy, setBusy] = useState<"draft" | null>(null);
  const [error, setError] = useState<EmailDeliveryError | null>(null);
  const autoDraftStartedRef = useRef(false);
  const sendStartedRef = useRef(false);

  const updateDraft = (field: keyof EmailDraft, value: string) => {
    const normalizedValue = field === "body" ? normalizeRichEmailText(value) : value;
    setDraft((current) => ({
      ...current,
      [field]: normalizedValue,
      ...(field === "body"
        ? { htmlBody: richEmailHtmlFromMarkdown(normalizedValue) }
        : {}),
    }));
    setMissingDetails([]);
    setError(null);
  };

  const withAuth = useCallback(async () => {
    const auth = await getAuth();
    if (!auth) {
      onRequireVault();
      return null;
    }
    return auth;
  }, [getAuth, onRequireVault]);

  const askOneToDraft = useCallback(async () => {
    const instruction = (autoDraft ? initialInstruction : draft.body).trim();
    if (!instruction) {
      setError(
        new EmailDeliveryError("Tell One what you want to write first.", 400),
      );
      return;
    }
    const auth = await withAuth();
    if (!auth) return;
    setBusy("draft");
    setError(null);
    try {
      const next = await EmailDeliveryService.draft({ ...auth, instruction });
      setDraft({
        to: next.to,
        cc: next.cc,
        bcc: next.bcc,
        subject: next.subject,
        body: normalizeRichEmailText(next.body),
        htmlBody: richEmailHtmlFromMarkdown(normalizeRichEmailText(next.body)),
      });
      if (next.cc || next.bcc) {
        setShowCcBcc(true);
      }
      setMissingDetails(next.missingDetails);
    } catch (cause) {
      setError(
        cause instanceof EmailDeliveryError
          ? cause
          : new EmailDeliveryError(
              "One could not prepare an email draft.",
              500,
            ),
      );
    } finally {
      setBusy(null);
    }
  }, [autoDraft, draft.body, initialInstruction, withAuth]);

  useEffect(() => {
    if (!autoDraft || autoDraftStartedRef.current) return;
    autoDraftStartedRef.current = true;
    void askOneToDraft();
  }, [askOneToDraft, autoDraft]);

  const send = () => {
    if (sendStartedRef.current) return;
    sendStartedRef.current = true;
    const reviewedDraft = { ...draft };
    // Close the editor before any token or provider request. The background
    // work keeps a snapshot of the exact owner-reviewed fields.
    const attemptId = onSendStarted?.(reviewedDraft) ?? null;

    void (async () => {
      try {
        const auth = await getAuth();
        if (!auth) {
          onRequireVault();
          throw new EmailDeliveryError("Unlock your vault and try again.", 403);
        }
        const prepared = await EmailDeliveryService.prepare({
          ...auth,
          draft: reviewedDraft,
          idempotencyKey: newIdempotencyKey(),
        });
        if (!prepared.actionId) {
          throw new EmailDeliveryError(
            "Email could not be prepared for sending.",
            500,
          );
        }
        const outcome = await EmailDeliveryService.send({
          ...auth,
          actionId: prepared.actionId,
          draft: reviewedDraft,
        });
        if (outcome.outcomeUnknown) {
          throw new EmailDeliveryError(
            "We could not confirm delivery. Check Sent Mail before trying again.",
            502,
            "EMAIL_ACTION_OUTCOME_UNKNOWN",
          );
        }
        onSent(attemptId);
      } catch (cause) {
        onSendFailed?.(
          cause instanceof EmailDeliveryError
            ? cause
            : new EmailDeliveryError(
                "Email could not be sent. Review it and try again.",
                500,
              ),
          attemptId,
        );
      }
    })();
  };

  const disabled = busy !== null;
  const isDrafting = busy === "draft";
  return (
    <section
      data-testid="one-email-draft-card"
      aria-label="Email draft"
      className="mb-5 overflow-hidden rounded-[calc(var(--app-card-radius-compact)+4px)] border border-border/80 bg-card shadow-[var(--app-card-shadow-standard)]"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border/60 bg-primary/[0.035] px-4 py-4 sm:px-5">
        <div className="flex min-w-0 gap-3.5">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--app-radius-lg)] bg-primary text-primary-foreground shadow-sm">
            <Mail className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.015em] text-foreground">
              Email draft
            </h2>
            <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
              {isDrafting
                ? "One is preparing a draft from your request…"
                : "Review the email exactly as it will be sent."}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Close email draft"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {isDrafting ? (
        <div
          aria-busy="true"
          className="space-y-4 px-4 py-5 sm:px-5"
          data-testid="one-email-draft-preparing"
        >
          <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/[0.055] px-3.5 py-3" role="status">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-foreground">Drafting your email</p>
              <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                One is turning your request into a reviewable email. This can take a few seconds.
              </p>
            </div>
          </div>
          <div aria-hidden className="space-y-4 animate-pulse">
            <div className="space-y-2">
              <div className="h-3 w-8 rounded bg-muted" />
              <div className="h-11 rounded-xl bg-muted/70" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="h-3 w-8 rounded bg-muted" />
                <div className="h-10 rounded-xl bg-muted/70" />
              </div>
              <div className="space-y-2">
                <div className="h-3 w-8 rounded bg-muted" />
                <div className="h-10 rounded-xl bg-muted/70" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-3 w-14 rounded bg-muted" />
              <div className="h-11 rounded-xl bg-muted/70" />
            </div>
            <div className="space-y-2">
              <div className="h-3 w-16 rounded bg-muted" />
              <div className="h-36 rounded-xl bg-muted/70" />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4 px-4 py-5 sm:px-5">
          <label className="block">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                To
              </span>
              {!showCcBcc ? (
                <button
                  type="button"
                  onClick={() => setShowCcBcc(true)}
                  className="text-xs font-medium text-primary transition-colors hover:underline focus-visible:outline-none"
                >
                  + CC / BCC
                </button>
              ) : null}
            </div>
            <Input
              id={`${idPrefix}-to`}
              data-testid="one-email-draft-to"
              type="text"
              value={draft.to}
              onChange={(event) => updateDraft("to", event.target.value)}
              disabled={disabled}
              placeholder="name@example.com"
              aria-label="To"
              className="h-11 rounded-xl bg-background/70 text-[15px]"
            />
          </label>

          {showCcBcc ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {(["cc", "bcc"] as const).map((field) => (
                <label key={field}>
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {field === "cc" ? "Cc" : "Bcc"}
                  </span>
                  <Input
                    id={`${idPrefix}-${field}`}
                    data-testid={`one-email-draft-${field}`}
                    type="text"
                    value={draft[field]}
                    onChange={(event) => updateDraft(field, event.target.value)}
                    disabled={disabled}
                    placeholder="Optional"
                    aria-label={field === "cc" ? "Cc" : "Bcc"}
                    className="h-10 rounded-xl bg-background/70 text-[15px]"
                  />
                </label>
              ))}
            </div>
          ) : null}

          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Subject
            </span>
            <Input
              id={`${idPrefix}-subject`}
              data-testid="one-email-draft-subject"
              type="text"
              value={draft.subject}
              onChange={(event) => updateDraft("subject", event.target.value)}
              disabled={disabled}
              aria-label="Subject"
              className="h-11 rounded-xl bg-background/70 text-[15px] font-medium"
            />
          </label>
          <label className="block">
            <span className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              <span>Message</span>
              <span className="normal-case font-normal tracking-normal">Rich email</span>
            </span>
            <EmailRichTextComposer
              disabled={disabled}
              id={`${idPrefix}-message`}
              onChange={(value) => updateDraft("body", value)}
              showPreviewOnFirstContent={autoDraft}
              value={draft.body}
            />
          </label>

          {missingDetails.length > 0 ? (
            <div
              className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-sm font-medium text-amber-700 dark:text-amber-300"
              data-testid="one-email-draft-missing-details"
            >
              <Sparkles className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>One still needs: {missingDetails.join(", ")}.</span>
            </div>
          ) : null}
          {error ? (
            <p
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm leading-5 text-destructive"
              role="alert"
            >
              {error.message}{" "}
              {error.needsGmailReconnect ? (
                <Link className="font-medium underline" href="/one/gmail">
                  Reconnect Gmail
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 border-t border-border/60 bg-muted/[0.16] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-center sm:justify-start"
          onClick={onDismiss}
        >
          {isDrafting ? "Close draft" : "Decline"}
        </Button>
        <Button
          type="button"
          size="sm"
          className="gap-2 rounded-xl px-4 sm:min-w-32"
          onClick={() => void send()}
          disabled={disabled}
          data-testid="one-email-draft-send"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </Button>
      </div>
    </section>
  );
}
