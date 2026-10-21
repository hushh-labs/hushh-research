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

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { useEffect, useState, type RefObject, type ReactNode } from "react";
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
import { IllustratedRequestContent, IllustratedRequestForm, IllustratedRequestBody, IllustratedRequestActions } from "@/components/app-ui/illustrated-request-dialog";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface RequestScopeButtonProps {
  personRef: string;
  personName: string;
  /** Optional profile action presentation; default callers keep the plain label. */
  renderTrigger?: (label: string) => ReactNode;
  className?: string;
  canRequest?: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

export function RequestScopeButton({
  personRef,
  personName,
  className,
  canRequest = true,
  returnFocusRef,
  renderTrigger,
}: RequestScopeButtonProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    setTakingLonger(false);
    if (!busy) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 5000);
    return () => window.clearTimeout(timer);
  }, [busy]);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  // Every active connection can open this, exactly like Request files. A
  // deployment that has not switched request intake on says so inside the
  // dialog; a disabled trigger left the person clicking a dead control with
  // no reason and no next step. The real guard is server-side: the create
  // endpoint still 503s when intake is off.
  //
  // Only the `requests` gate is consulted. Payments are a separate gate and
  // are not reached from this form: the owner has to approve scopes and set
  // a price first, so a paused payment lane must not hide the question box.
  //
  // Four states, because "we have not asked yet", "intake is switched off"
  // and "we could not ask" need different words. Collapsing the last two
  // told people a feature was disabled when they were signed out or offline,
  // and offered them no retry.
  const [gate, setGate] = useState<
    | { kind: "checking" }
    | { kind: "ready" }
    | { kind: "disabled" }
    | { kind: "blocked"; message: string }
  >({ kind: "checking" });
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    setGate({ kind: "checking" });
    let cancelled = false;
    void (async () => {
      try {
        const token = await AuthService.getIdToken();
        if (!token) throw new Error("Sign in to send this request.");
        const gates = await AnswerRequestService.gates(token);
        if (!cancelled)
          setGate(gates.requests ? { kind: "ready" } : { kind: "disabled" });
      } catch (cause) {
        if (cancelled) return;
        // Still not sendable, but retryable and for a different reason.
        setGate({
          kind: "blocked",
          message:
            cause instanceof Error
              ? cause.message
              : "Could not check whether this can be sent.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [personRef, user?.uid, recheck]);

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
    if (!canRequest || gate.kind !== "ready" || !valid || busy) return;
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
      if (user?.uid) CacheSyncService.onConsentMutated(user.uid);
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
      {canRequest ? <DialogTrigger asChild>
        <Button
          size="standard"
          variant="none"
          className={className}
          data-voice-control-id="person-profile-request-scope"
        >
          {renderTrigger?.("Request scope") ?? "Request scope"}
        </Button>
      </DialogTrigger> : null}
      <IllustratedRequestContent
        intent="question"
        title={created ? "Question sent" : "Ask a question"}
        description={`To ${personName}`}
        success={Boolean(created)}
        data-request-scope-dialog
        showCloseButton={!busy}
        srDescription={`Ask ${personName} a question.`}
        onCloseAutoFocus={(event) => {
          if (!canRequest && returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        {created ? (
          <IllustratedRequestBody>
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
              disabled={!canRequest}
              onClick={() => {
                setCreated(null);
                reset();
              }}
            >
              Ask another question
            </Button>
          </IllustratedRequestBody>
        ) : gate.kind === "checking" ? (
          <IllustratedRequestBody><BodyText role="status">Checking whether this can be sent…</BodyText></IllustratedRequestBody>
        ) : gate.kind === "disabled" ? (
          // A reason and a next step, not a dead control. Deliberately does
          // not name an env flag: the person reading it cannot set one. No
          // retry, because retrying cannot change a deployment setting.
          <IllustratedRequestBody>
            <BodyText role="status">
              Requests are not switched on here yet, so this question cannot
              be sent. Nothing has been sent to {personName}.
            </BodyText>
            <Button type="button" size="standard" variant="none" onClick={close}>
              Close
            </Button>
          </IllustratedRequestBody>
        ) : gate.kind === "blocked" ? (
          // Signed out or unreachable: a different cause from a disabled
          // lane, so it gets its own words and a retry that can succeed.
          <IllustratedRequestBody>
            <BodyText role="status">
              {gate.message} Nothing has been sent to {personName}.
            </BodyText>
            <Button
              type="button"
              size="prominent"
              onClick={() => setRecheck((value) => value + 1)}
            >
              Try again
            </Button>
            <Button type="button" size="standard" variant="none" onClick={close}>
              Close
            </Button>
          </IllustratedRequestBody>
        ) : (
          <IllustratedRequestForm
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <IllustratedRequestBody>
            <div className="space-y-[var(--app-form-field-gap)]">
              <Label htmlFor="answer-request-question">Your question</Label>
              <Textarea
                id="answer-request-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={2000}
                required
                disabled={busy}
                placeholder="What is the best way to contact you?"
              />
            </div>
            <HelperText as="p">{ANSWER_REQUEST_HELPER}</HelperText>
            {error ? (
              <HelperText as="p" role="alert">
                {error}
              </HelperText>
            ) : null}
            </IllustratedRequestBody>
            <IllustratedRequestActions>
            <FlowActionGroup
              primary={
                <Button
                  type="submit"
                  size="prominent"
                  disabled={!canRequest || !valid || busy}
                >
                  {busy ? takingLonger ? "Still sending—please wait…" : "Sending…" : "Send request"}
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
            </IllustratedRequestActions>
          </IllustratedRequestForm>
        )}
      </IllustratedRequestContent>
    </Dialog>
  );
}
