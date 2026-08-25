"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Mail, Send, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  const [draft, setDraft] = useState<EmailDraft>({
    ...EMPTY_DRAFT,
    ...(initialDraft ?? {}),
    body: initialDraft?.body ?? (autoDraft ? "" : initialInstruction),
  });
  const [missingDetails, setMissingDetails] = useState<string[]>([]);
  const [busy, setBusy] = useState<"draft" | null>(null);
  const [error, setError] = useState<EmailDeliveryError | null>(null);
  const autoDraftStartedRef = useRef(false);
  const sendStartedRef = useRef(false);

  const updateDraft = (field: keyof EmailDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
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
        body: next.body,
      });
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
  return (
    <section
      data-testid="one-email-draft-card"
      aria-label="Email draft"
      className="mb-4 overflow-hidden rounded-[calc(var(--app-card-radius-compact)+4px)] border border-border/80 bg-card shadow-[var(--app-card-shadow-standard)]"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border/60 bg-primary/[0.035] px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Mail className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">
              Email draft
            </h2>
            <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
              {busy === "draft"
                ? "One is preparing a draft from your request…"
                : "Review or edit the details, then send when ready."}
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
          disabled={disabled}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-3 px-4 py-4 sm:px-5">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            To
          </span>
          <Input
            id={`${idPrefix}-to`}
            data-testid="one-email-draft-to"
            type="text"
            value={draft.to}
            onChange={(event) => updateDraft("to", event.target.value)}
            disabled={disabled}
            placeholder="name@example.com"
            aria-label="To"
            className="h-11 bg-background/70"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["cc", "bcc"] as const).map((field) => (
            <label key={field}>
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
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
                className="h-10 bg-background/70"
              />
            </label>
          ))}
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
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
            className="h-11 bg-background/70"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Message
          </span>
          <Textarea
            id={`${idPrefix}-message`}
            data-testid="one-email-draft-message"
            value={draft.body}
            onChange={(event) => updateDraft("body", event.target.value)}
            disabled={disabled}
            placeholder="Write your message…"
            className="min-h-36 resize-y bg-background/70 leading-6"
            aria-label="Message"
          />
        </label>

        {missingDetails.length > 0 ? (
          <p
            className="rounded-lg bg-muted/55 px-3 py-2 text-sm leading-5 text-muted-foreground"
            data-testid="one-email-draft-missing-details"
          >
            One still needs: {missingDetails.join(", ")}.
          </p>
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

      <div className="flex flex-col-reverse gap-2 border-t border-border/60 bg-muted/[0.16] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-center sm:justify-start"
          onClick={onDismiss}
          disabled={disabled}
        >
          Decline
        </Button>
        <Button
          type="button"
          size="sm"
          className="gap-2 sm:min-w-32"
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
