"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, CheckCircle2, Loader2, Mail, Send, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  EmailDeliveryError,
  EmailDeliveryService,
  type EmailDraft,
  type PreparedEmailSend,
} from "@/lib/services/email-delivery-service";

type EmailDraftCardProps = {
  initialInstruction: string;
  /** The person explicitly asked One to draft from a Gmail entry point. */
  autoDraft?: boolean;
  getAuth: () => Promise<{
    firebaseIdToken: string;
    vaultOwnerToken: string;
  } | null>;
  onRequireVault: () => void;
  onDismiss: () => void;
  onSent: () => void;
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
  autoDraft = false,
  getAuth,
  onRequireVault,
  onDismiss,
  onSent,
}: EmailDraftCardProps) {
  const idPrefix = useId();
  const [draft, setDraft] = useState<EmailDraft>({
    ...EMPTY_DRAFT,
    body: autoDraft ? "" : initialInstruction,
  });
  const [missingDetails, setMissingDetails] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<PreparedEmailSend | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<"draft" | "prepare" | "send" | null>(null);
  const [error, setError] = useState<EmailDeliveryError | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const autoDraftStartedRef = useRef(false);

  const updateDraft = (field: keyof EmailDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    // A prepared action is bound to every normalized field. It cannot survive
    // an edit, including whitespace changes, recipient changes, or a redraft.
    setPrepared(null);
    setIdempotencyKey(null);
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
      setPrepared(null);
      setIdempotencyKey(null);
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

  const prepare = async () => {
    // The reviewed envelope is retained in component memory, but the large
    // editor should get out of the conversation immediately. The compact
    // record expands again if preparation fails or the owner wants to edit.
    setDetailsOpen(false);
    const auth = await withAuth();
    if (!auth) {
      setDetailsOpen(true);
      return;
    }
    const nextIdempotencyKey = newIdempotencyKey();
    setBusy("prepare");
    setError(null);
    try {
      const next = await EmailDeliveryService.prepare({
        ...auth,
        draft,
        idempotencyKey: nextIdempotencyKey,
      });
      if (!next.actionId) {
        throw new EmailDeliveryError(
          "Email review could not be prepared.",
          500,
        );
      }
      setPrepared(next);
      setIdempotencyKey(nextIdempotencyKey);
    } catch (cause) {
      setDetailsOpen(true);
      setError(
        cause instanceof EmailDeliveryError
          ? cause
          : new EmailDeliveryError("Email review could not be prepared.", 500),
      );
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!prepared || !idempotencyKey) return;
    const auth = await withAuth();
    if (!auth) return;
    setBusy("send");
    setError(null);
    try {
      const outcome = await EmailDeliveryService.send({
        ...auth,
        actionId: prepared.actionId,
        draft,
        idempotencyKey,
      });
      if (outcome.outcomeUnknown) {
        setPrepared(null);
        setIdempotencyKey(null);
        setDetailsOpen(true);
        setError(
          new EmailDeliveryError(
            "We could not confirm delivery. Check Sent Mail before trying again.",
            502,
            "EMAIL_ACTION_OUTCOME_UNKNOWN",
          ),
        );
        return;
      }
      onSent();
    } catch (cause) {
      setDetailsOpen(true);
      setError(
        cause instanceof EmailDeliveryError
          ? cause
          : new EmailDeliveryError(
              "Email could not be sent. Review it and try again.",
              500,
            ),
      );
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  if (!detailsOpen) {
    // `withAuth()` yields before `busy` is set. Until the prepared action is
    // present, this compact record must stay in its honest loading state.
    const isPreparing = busy === "prepare" || !prepared;
    const recipientSummary = draft.to.trim() || "No recipient added";
    const subjectSummary = draft.subject.trim() || "No subject";

    return (
      <section
        data-testid="one-email-draft-card"
        aria-label="Email draft"
        className="mb-4 overflow-hidden rounded-[calc(var(--app-card-radius-compact)+2px)] border border-border/80 bg-card shadow-[var(--app-card-shadow-standard)]"
      >
        <div
          className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
          data-testid="one-email-draft-collapsed"
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => setDetailsOpen(true)}
            aria-expanded="false"
            aria-label="Open email details"
            disabled={busy === "send"}
          >
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              {isPreparing ? (
                <Loader2 className="h-4.5 w-4.5 animate-spin" />
              ) : (
                <Mail className="h-4.5 w-4.5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                {isPreparing ? "Preparing email…" : "Email ready to send"}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {recipientSummary} · {subjectSummary}
              </p>
            </div>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          <div className="flex items-center gap-2 sm:shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              disabled={disabled}
            >
              Decline
            </Button>
            {prepared ? (
              <Button
                type="button"
                size="sm"
                className="gap-2"
                onClick={() => void send()}
                disabled={disabled}
                data-testid="one-email-draft-send"
              >
                {busy === "send" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Send email
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

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
                : prepared
                  ? "Ready for your final confirmation."
                  : "Review or edit the details before sending."}
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
        {prepared ? (
          <p
            className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm leading-5 text-foreground"
            data-testid="one-email-draft-ready"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            Reviewed. This exact email is ready to send.
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
        {prepared ? (
          <Button
            type="button"
            size="sm"
            className="gap-2 sm:min-w-32"
            onClick={() => void send()}
            disabled={disabled}
            data-testid="one-email-draft-send"
          >
            {busy === "send" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send email
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="gap-2 sm:min-w-40"
            onClick={() => void prepare()}
            disabled={disabled}
            data-testid="one-email-draft-review"
          >
            {busy === "prepare" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Review &amp; continue
          </Button>
        )}
      </div>
    </section>
  );
}
