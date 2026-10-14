"use client";

/**
 * Owner review for one paid-answer request.
 *
 * The semantic resolver proposes the exact memory; the owner reviews it and
 * confirms a price with explicit Gemini processing consent. Failed resolution
 * permits retry or decline only.
 *
 * Approval binds the question, the chosen scopes, both people and the quote
 * into one terms digest. Changing any of them afterwards invalidates a payment
 * made against the old terms, so the owner is approving exactly what they see.
 */

import { useState } from "react";

import { AuthService } from "@/lib/services/auth-service";
import {
  AnswerRequestService,
  type PendingAnswerRequest,
} from "@/lib/services/answer-request-service";
import { DocumentRequestPriceSheet } from "@/components/consent/document-request-price-sheet";
import { Button } from "@/lib/morphy-ux/button";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Label } from "@/components/ui/label";

export interface AnswerRequestReviewProps {
  request: PendingAnswerRequest;
  requesterLabel: string;
  onResolved?: (requestId: string) => void;
  onApproved?: () => void;
}

export function AnswerRequestReview({
  request,
  requesterLabel,
  onResolved,
  onApproved,
}: AnswerRequestReviewProps) {
  const matched = request.resolutionMode === "agent" && request.proposedScopes.length > 0;
  const chosen = matched ? request.proposedScopes.map(entry => entry.scope) : [];
  const [consented, setConsented] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: (token: string) => Promise<unknown>, approved = false) => {
    setBusy(true);
    setError(null);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to review this request.");
      await action(token);
      setPriceOpen(false);
      onResolved?.(request.requestId);
      if (approved) onApproved?.();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "This could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  const approve = (amountCents: number | null) => {
    if (amountCents === null) return;
    if (!consented || !matched) { setError("Agree to Gemini processing of the matched memory before confirming."); return; }
    void run((token) =>
      AnswerRequestService.approve(
        token,
        request.requestId,
        chosen,
        amountCents,
        consented,
      ), true,
    );
  };

  return (
    <div className="min-w-0 space-y-4">
      {/* Exactly one modal on screen at a time: once the price sheet opens,
          this review's own form is not rendered behind it. The outer detail
          panel (titled "Request scope · Memory") stays mounted so Back/Escape
          still close the whole flow, but its body is empty while the nested
          price sheet is the thing actually showing. */}
      {!priceOpen ? (
        <>
          <div className="space-y-1">
            <HelperText as="p">Request scope · Memory</HelperText>
            <HelperText as="p">The requester asked</HelperText>
            <BodyText className="break-words">“{request.question}”</BodyText>
            {request.periodStart && request.periodEnd ? (
              <HelperText as="p">
                Covering {request.periodStart} to {request.periodEnd}
              </HelperText>
            ) : null}
          </div>

          <HelperText as="p">One will use the matched memory with Gemini to prepare this answer.</HelperText>
          {matched ? (
            <>
              <HelperText as="p">Uses: {request.proposedScopes.map(entry => {
                const labels: Record<string, string> = {
                  "attr.identity.identity_profile.full_name": "Name",
                  "attr.identity.identity_profile.declared_age": "Age",
                  "attr.identity.identity_profile.sex": "Sex",
                  "attr.identity.identity_profile.profile_photo_url": "Profile photo",
                };
                return labels[entry.scope] || entry.label || "Matched memory";
              }).join(", ")}</HelperText>
              {/* Consent is captured here, bound to the exact question and
                  matched scopes, before a price is ever chosen. The price
                  sheet that follows asks only for the price. */}
              <Label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={consented}
                  disabled={busy}
                  onChange={event => setConsented(event.target.checked)}
                />
                I agree to Google Gemini processing this question and the matched information.
              </Label>
            </>
          ) : (
            <div role="status" className="space-y-2">
              <HelperText as="p">{request.resolutionMode === null ? "Matching this question to your memory…" : "We couldn’t match this question to your memory."}</HelperText>
              {request.resolutionMode !== null && <Button type="button" disabled={busy} onClick={() => void run(token => AnswerRequestService.retryResolution(token, request.requestId))}>Retry matching</Button>}
            </div>
          )}

          {error ? (
            <HelperText as="p" role="alert">
              {error}
            </HelperText>
          ) : null}

          <FlowActionGroup
            primary={
              <Button
                type="button"
                size="prominent"
                disabled={busy || !matched || !consented}
                onClick={() => setPriceOpen(true)}
              >
                Set a price
              </Button>
            }
            secondary={
              <Button
                type="button"
                size="standard"
                variant="none"
                disabled={busy}
                onClick={() =>
                  void run((token) =>
                    AnswerRequestService.decline(token, request.requestId),
                  )
                }
              >
                Don&apos;t allow
              </Button>
            }
          />
        </>
      ) : null}

      {/* Drive's price sheet, with this lane's own description. Its whole-dollar
          rule, presets and "Allow · $N" affordance are unchanged.
          paymentRequired is always true here: a paid answer with no price is
          not a thing this lane can express. Consent was already recorded on
          the review step above, so this step asks only for the price. */}
      <DocumentRequestPriceSheet
        open={priceOpen}
        requesterLabel={requesterLabel}
        purpose={request.question}
        // This lane delivers one written answer, not files. The sheet's own
        // sentence described a Drive search the owner is not authorizing.
        description="After you approve, your unlocked device prepares and encrypts one answer from the selected memory. They pay this price only when it is ready, and verified payment releases it."
        periodStart={request.periodStart}
        periodEnd={request.periodEnd}
        paymentRequired
        // Consent and payout management already have their own places
        // (the review step above, and Settings); the price step is price only.
        settlement={<></>}
        busy={busy}
        error={error}
        onSubmit={approve}
        onCancel={() => setPriceOpen(false)}
      />
    </div>
  );
}
