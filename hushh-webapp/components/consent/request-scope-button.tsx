"use client";

/**
 * "Request scope" — ask a connected person's private agent a question.
 *
 * Reuses the profile request dialog primitives: recipient, one question,
 * Cancel and Send request. Any period the person asks about stays in the
 * question. Scope resolution remains server-side, and the owner approves
 * the exact question, scopes and price before any money moves.
 *
 * No connector setup and no trusted-circle membership: an active connection is
 * the whole gate, matching the existing request lanes.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";

import { AuthService } from "@/lib/services/auth-service";
import {
  ANSWER_REQUEST_HELPER,
  AnswerRequestService,
  validAnswerRequest,
} from "@/lib/services/answer-request-service";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { Button } from "@/lib/morphy-ux/button";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  // Every active connection can open this, exactly like Request files. A
  // deployment that has not switched the paid-answer lane on says so inside
  // the dialog; a disabled trigger left the person clicking a dead control
  // with no reason and no next step. The real guard is server-side: the
  // create endpoint still 503s when the lane is off.
  //
  // Tri-state, because "we have not asked yet" and "the answer was no" are
  // different things to show. Starting at 'unavailable' would flash the wrong
  // reason on every open.
  const [availability, setAvailability] = useState<
    "checking" | "available" | "unavailable"
  >("checking");

  useEffect(() => {
    setAvailability("checking");
    let cancelled = false;
    void (async () => {
      const token = await AuthService.getIdToken().catch(() => null);
      // No token is not a configuration answer, but it is still not sendable,
      // and `available` already fails closed on anything it cannot confirm.
      const available = token
        ? await AnswerRequestService.available(token)
        : false;
      if (!cancelled) setAvailability(available ? "available" : "unavailable");
    })();
    return () => {
      cancelled = true;
    };
  }, [personRef, user?.uid]);

  const valid = validAnswerRequest({ question });

  const reset = () => {
    setQuestion("");
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
      const { requestId } = await AnswerRequestService.create(
        token,
        personRef,
        {
          question,
        },
      );
      setCreated(requestId);
      reset();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This request could not be sent.",
      );
    } finally {
      setBusy(false);
    }
  };

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
        className="max-h-[85dvh] overflow-y-auto sm:max-w-md"
        showCloseButton={Boolean(created) || availability !== "available"}
        srDescription={`Ask ${personName} a question.`}
      >
        <DialogHeader className="text-left">
          <DialogTitle>Request scope</DialogTitle>
          <HelperText as="p" className="break-words">
            To {personName}
          </HelperText>
        </DialogHeader>
        {created ? (
          <div className="min-w-0 space-y-4">
            <BodyText role="status">
              Request sent. {personName} reviews the question and the exact
              information it would use, then sets a price.
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
        ) : availability === "checking" ? (
          <BodyText role="status">Checking whether this can be sent…</BodyText>
        ) : availability === "unavailable" ? (
          // A reason and a next step, not a dead control. Deliberately does
          // not name an env flag: the person reading it cannot set one.
          <div className="min-w-0 space-y-4">
            <BodyText role="status">
              Paid answers are not switched on here yet, so this question
              cannot be sent. Nothing has been sent to {personName}.
            </BodyText>
            <Button type="button" size="standard" variant="none" onClick={close}>
              Close
            </Button>
          </div>
        ) : (
          <form
            className="min-w-0 space-y-[var(--app-form-section-gap)]"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-[var(--app-form-field-gap)]">
              <Label htmlFor="answer-request-question">Question</Label>
              <Textarea
                id="answer-request-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={2000}
                required
                disabled={busy}
                placeholder="E.g. What is your age?"
              />
            </div>
            <HelperText as="p">{ANSWER_REQUEST_HELPER}</HelperText>
            {error ? (
              <HelperText as="p" role="alert">
                {error}
              </HelperText>
            ) : null}
            <FlowActionGroup
              primary={
                <Button
                  type="submit"
                  size="prominent"
                  disabled={!valid || busy}
                >
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
