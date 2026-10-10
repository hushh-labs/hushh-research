"use client";

/**
 * "Request scope" — ask a connected person's private agent a question.
 *
 * Deliberately the same dialog shape as Request files
 * (`document-file-request.tsx`): recipient line, "What do you need?",
 * period controls, Cancel and Send request. It reuses the same primitives so
 * the two requests on this profile read as one family.
 *
 * Two differences, both intentional:
 *
 * 1. The period is conditional. A Drive file request always covers a date
 *    range; a question often does not ("what are your food preferences?").
 *    The owner must still be able to approve an exact period when one applies,
 *    so it is opt-in and then required, rather than always-required or never
 *    asked.
 * 2. Nothing here resolves the question into scopes. That is a semantic
 *    judgement made server-side by the resolver stage and then narrowed by
 *    fail-closed validation; the owner approves the exact question, the exact
 *    scopes and the price before any money moves.
 *
 * No connector setup and no trusted-circle membership: an active connection is
 * the whole gate, matching the existing request lanes.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import { AuthService } from "@/lib/services/auth-service";
import {
  ANSWER_REQUEST_HELPER,
  AnswerRequestService,
  validAnswerPeriod,
  validAnswerRequest,
} from "@/lib/services/answer-request-service";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { Button } from "@/lib/morphy-ux/button";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { MobileDocumentDateRange } from "@/components/consent/mobile-document-date-range";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface RequestScopeButtonProps {
  personRef: string;
  personName: string;
  /** Grid placement from the profile's action cluster. */
  className?: string;
}

export function RequestScopeButton({
  personRef,
  personName,
  className,
}: RequestScopeButtonProps) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [hasPeriod, setHasPeriod] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  // The lane ships disabled. Ask before offering the CTA at all, so an
  // environment without it never shows a button that refuses on submit.
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await AuthService.getIdToken().catch(() => null);
      if (!token) return;
      const available = await AnswerRequestService.available(token);
      if (!cancelled) setEnabled(available);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const periodStart = hasPeriod ? start || null : null;
  const periodEnd = hasPeriod ? end || null : null;
  // An opted-in period must be complete: a half-filled range would let the
  // owner approve a window neither person actually chose.
  const periodReady = !hasPeriod || Boolean(start && end);
  const valid =
    validAnswerRequest({ question, periodStart, periodEnd }) && periodReady;

  const reset = () => {
    setQuestion("");
    setHasPeriod(false);
    setStart("");
    setEnd("");
    setError(null);
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    setCreated(null);
    reset();
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to send this request.");
      const { requestId } = await AnswerRequestService.create(token, personRef, {
        question,
        periodStart,
        periodEnd,
      });
      setCreated(requestId);
      reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This request could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) return null;

  return (
    <Dialog
      modal
      open={open}
      onOpenChange={(value) => {
        if (value) setOpen(true);
        else close();
      }}
    >
      <DialogTrigger asChild>
        {/* Same bare Button as the file actions, so `.actions button` in
            person-profile-page.module.css gives it their exact styling. The
            className carries only grid placement: a third auto-placed button
            would skip the occupied Manage row and land underneath it. */}
        <Button
          size="standard"
          variant="none"
          className={className}
          data-voice-control-id="person-profile-request-scope"
        >
          Request scope
        </Button>
      </DialogTrigger>
      <DialogContent
        data-request-scope-dialog
        className="max-h-[85dvh] overflow-y-auto max-sm:translate-x-0 max-sm:translate-y-0 sm:max-w-md"
        showCloseButton={Boolean(created)}
        srDescription={`Ask ${personName} a question.`}
      >
        <DialogHeader>
          <DialogTitle>Request scope</DialogTitle>
          <HelperText as="p" className="break-words">
            To {personName}
          </HelperText>
        </DialogHeader>
        {created ? (
          <div className="min-w-0 space-y-4">
            <BodyText role="status">
              Request sent. {personName} reviews the question and the exact information it
              would use, then sets a price.
            </BodyText>
            <Button asChild size="prominent">
              <Link
                href={buildConsentCenterHref("pending", {
                  requestId: `answer_request:${created}`,
                  requestView: "sent",
                })}
              >
                View request
              </Link>
            </Button>
            <Button
              type="button"
              size="standard"
              variant="none"
              onClick={() => {
                setCreated(null);
                reset();
              }}
            >
              Ask another question
            </Button>
          </div>
        ) : (
          <form
            className="min-w-0 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="answer-request-question">What do you need?</Label>
              <Textarea
                id="answer-request-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={2000}
                required
                disabled={busy}
                placeholder="How much did you spend on travel last year?"
              />
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="answer-request-has-period" className="flex items-center gap-2">
                <input
                  id="answer-request-has-period"
                  type="checkbox"
                  checked={hasPeriod}
                  disabled={busy}
                  onChange={(event) => setHasPeriod(event.target.checked)}
                />
                This covers a specific period
              </Label>
            </div>
            {hasPeriod ? (
              <fieldset className="min-w-0" disabled={busy}>
                <legend className="mb-2">Period (required)</legend>
                <MobileDocumentDateRange
                  start={start}
                  end={end}
                  onStartChange={setStart}
                  onEndChange={setEnd}
                />
                <div className="hidden min-w-0 gap-3 sm:grid sm:grid-cols-2">
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor="answer-period-start">Start date</Label>
                    <Input
                      id="answer-period-start"
                      type="date"
                      value={start}
                      onChange={(event) => setStart(event.target.value)}
                      required
                    />
                  </div>
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor="answer-period-end">End date</Label>
                    <Input
                      id="answer-period-end"
                      type="date"
                      value={end}
                      onChange={(event) => setEnd(event.target.value)}
                      required
                    />
                  </div>
                </div>
              </fieldset>
            ) : null}
            {hasPeriod && !periodReady ? (
              <HelperText role="status">
                Choose exact start and end dates before sending this request.
              </HelperText>
            ) : null}
            {hasPeriod && start && end && !validAnswerPeriod(start, end) ? (
              <HelperText role="status">
                Choose both dates, with the end on or after the start.
              </HelperText>
            ) : null}
            <HelperText as="p">{ANSWER_REQUEST_HELPER}</HelperText>
            {error ? (
              <HelperText as="p" role="alert">
                {error}
              </HelperText>
            ) : null}
            <FlowActionGroup
              primary={
                <Button type="submit" size="prominent" disabled={!valid || busy}>
                  {busy ? "Sending…" : "Send request"}
                </Button>
              }
              secondary={
                <Button
                  type="button"
                  size="standard"
                  variant="none"
                  disabled={busy}
                  onClick={close}
                >
                  Cancel
                </Button>
              }
            />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
