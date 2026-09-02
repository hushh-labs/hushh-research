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
import {
  ConnectionsService,
  type ConnectionSummaryEntry,
} from "@/lib/services/connections-service";

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

function parseToFieldSegment(toValue: string) {
  const lastIndex = Math.max(toValue.lastIndexOf(","), toValue.lastIndexOf(";"));
  if (lastIndex === -1) {
    return { prefix: "", activeQuery: toValue.trim().toLowerCase() };
  }
  const rawPrefix = toValue.slice(0, lastIndex + 1);
  const prefix = rawPrefix.endsWith(" ") ? rawPrefix : `${rawPrefix} `;
  const activeQuery = toValue.slice(lastIndex + 1).trim().toLowerCase();
  return { prefix, activeQuery };
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
  const [connections, setConnections] = useState<ConnectionSummaryEntry[]>([]);
  const [showToDropdown, setShowToDropdown] = useState(false);
  const toDropdownRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<"draft" | null>(null);
  const [error, setError] = useState<EmailDeliveryError | null>(null);
  const autoDraftStartedRef = useRef(false);
  const sendStartedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const auth = await getAuth();
        if (!auth?.firebaseIdToken) return;
        const list = await ConnectionsService.listConnections({ idToken: auth.firebaseIdToken });
        if (active) setConnections(list);
      } catch {
        // Degrade silently if connections fetch fails
      }
    })();
    return () => { active = false; };
  }, [getAuth]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (toDropdownRef.current && !toDropdownRef.current.contains(event.target as Node)) {
        setShowToDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const updateDraft = (field: keyof EmailDraft, value: string) => {
    const isBody = field === "body";
    const isHtml = isBody && value.trim().startsWith("<") && value.includes(">");
    setDraft((current) => ({
      ...current,
      [field]: isBody ? (isHtml ? value : normalizeRichEmailText(value)) : value,
      ...(isBody
        ? { htmlBody: isHtml ? value : richEmailHtmlFromMarkdown(normalizeRichEmailText(value)) }
        : {}),
    }));
    setMissingDetails([]);
    setError(null);
  };

  const selectConnection = (conn: ConnectionSummaryEntry) => {
    const chosenEmail = conn.email?.trim() || "";
    if (!chosenEmail) return;
    const { prefix } = parseToFieldSegment(draft.to);
    updateDraft("to", `${prefix}${chosenEmail}`);
    setShowToDropdown(false);
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

  const { activeQuery } = parseToFieldSegment(draft.to);

  const matchingConnections = connections
    .filter((conn) => {
      if (!activeQuery) return true;
      const nameMatch = conn.displayName?.toLowerCase().includes(activeQuery);
      const emailMatch = conn.email?.toLowerCase().includes(activeQuery);
      return Boolean(nameMatch || emailMatch);
    })
    .slice(0, 6);

  return (
    <section
      data-testid="one-email-draft-card"
      aria-label="Email draft"
      className="mb-5 overflow-hidden rounded-[calc(var(--app-card-radius-compact)+4px)] border border-border/80 bg-card shadow-[var(--app-card-shadow-standard)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-4 py-3.5 sm:px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Mail className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Review Email Draft
            </h2>
            <p className="text-xs text-muted-foreground">
              Verify recipients and content before sending
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none"
          aria-label="Dismiss draft"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isDrafting ? (
        <div className="space-y-4 p-6 sm:p-8">
          <div
            data-testid="one-email-draft-preparing"
            role="status"
            aria-busy="true"
            className="flex items-center gap-3 text-sm font-medium text-primary"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>One is preparing your email draft...</span>
          </div>
          <div className="space-y-3 pt-2">
            <div className="h-4 w-1/3 rounded bg-muted animate-pulse" />
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
          </div>
        </div>
      ) : (
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <div className="relative flex items-center gap-2 border-b border-border/60 py-1.5" ref={toDropdownRef}>
            <span className="w-16 shrink-0 text-sm font-medium text-muted-foreground">To</span>
            <Input
              id={`${idPrefix}-to`}
              data-testid="one-email-draft-to"
              type="text"
              value={draft.to}
              onFocus={() => setShowToDropdown(true)}
              onChange={(event) => {
                updateDraft("to", event.target.value);
                setShowToDropdown(true);
              }}
              disabled={disabled}
              placeholder="Select connection or type email..."
              aria-label="To"
              className="h-9 rounded-none border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
            />
            {!showCcBcc ? (
              <button
                type="button"
                onClick={() => setShowCcBcc(true)}
                className="ml-auto shrink-0 text-xs font-medium text-primary transition-colors hover:underline focus-visible:outline-none"
              >
                + CC / BCC
              </button>
            ) : null}

            {/* Autocomplete Dropdown */}
            {showToDropdown && matchingConnections.length > 0 ? (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-xl border border-border/60 bg-popover/95 p-1.5 shadow-lg backdrop-blur-md">
                <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Connections
                </div>
                {matchingConnections.map((conn) => {
                  const hasEmail = Boolean(conn.email?.trim());
                  return (
                    <button
                      key={conn.userId}
                      type="button"
                      disabled={!hasEmail}
                      onClick={() => selectConnection(conn)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                        hasEmail
                          ? "hover:bg-accent cursor-pointer"
                          : "opacity-50 cursor-not-allowed"
                      }`}
                    >
                      {conn.photoUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={conn.photoUrl} alt="" className="h-7 w-7 rounded-full object-cover shrink-0" />
                      ) : (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-medium text-xs">
                          {(conn.displayName || "C").charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium text-foreground text-xs">
                          {conn.displayName || "Connected User"}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {hasEmail ? conn.email : "No email on file (non-selectable)"}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          {showCcBcc ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {(["cc", "bcc"] as const).map((field) => (
                <div className="flex items-center gap-2 border-b border-border/60 py-1.5" key={field}>
                  <span className="w-16 shrink-0 text-sm font-medium text-muted-foreground">
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
                    className="h-9 rounded-none border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
                  />
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-2 border-b border-border/60 py-1.5">
            <span className="w-16 shrink-0 text-sm font-medium text-muted-foreground">Subject</span>
            <Input
              id={`${idPrefix}-subject`}
              data-testid="one-email-draft-subject"
              type="text"
              value={draft.subject}
              onChange={(event) => updateDraft("subject", event.target.value)}
              disabled={disabled}
              placeholder="Subject"
              aria-label="Subject"
              className="h-9 rounded-none border-0 bg-transparent px-0 text-[15px] font-medium shadow-none focus-visible:ring-0"
            />
          </div>

          <div className="pt-2">
            <EmailRichTextComposer
              disabled={disabled}
              id={`${idPrefix}-message`}
              onChange={(value) => updateDraft("body", value)}
              showPreviewOnFirstContent={autoDraft}
              value={draft.body}
            />
          </div>

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
