"use client";

/**
 * Owner review for one paid-answer request.
 *
 * Two decisions, in the order the owner actually makes them:
 *
 *   1. What may this answer use? The resolver's proposal is shown as
 *      checkboxes so the owner can narrow it. They can only narrow: the server
 *      refuses a scope that was never offered, and deterministic validation
 *      has already dropped anything another person may never request.
 *   2. What is it worth? That reuses Drive's own price sheet unchanged, so the
 *      whole-dollar rule, the preset chips and the "Allow · $N" affordance are
 *      literally the same control, not a copy of it.
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
}

export function AnswerRequestReview({
  request,
  requesterLabel,
  onResolved,
}: AnswerRequestReviewProps) {
  const [chosen, setChosen] = useState<string[]>(() =>
    request.proposedScopes.map((entry) => entry.scope),
  );
  const [priceOpen, setPriceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (scope: string) =>
    setChosen((current) =>
      current.includes(scope)
        ? current.filter((entry) => entry !== scope)
        : [...current, scope],
    );

  const run = async (action: (token: string) => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to review this request.");
      await action(token);
      setPriceOpen(false);
      onResolved?.(request.requestId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const approve = (amountCents: number | null) => {
    if (amountCents === null) return;
    void run((token) =>
      AnswerRequestService.approve(token, request.requestId, chosen, amountCents),
    );
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-1">
        <HelperText as="p">{requesterLabel} asked</HelperText>
        <BodyText className="break-words">“{request.question}”</BodyText>
        {request.periodStart && request.periodEnd ? (
          <HelperText as="p">
            Covering {request.periodStart} to {request.periodEnd}
          </HelperText>
        ) : null}
      </div>

      {/* A skipped resolver is stated, not hidden. Approving a hand-picked set
          after a skip is a different act from approving a judged resolution,
          and the owner is entitled to know which one they are doing. */}
      {request.resolutionMode === "skipped" ? (
        <HelperText as="p" role="status">
          This question was not matched to your information automatically. Choose what it
          may use yourself.
        </HelperText>
      ) : null}

      <fieldset className="min-w-0 space-y-2" disabled={busy}>
        <legend className="mb-2">What this answer may use</legend>
        {request.proposedScopes.length === 0 ? (
          <HelperText as="p" role="status">
            Nothing of yours matched this question. Decline it, or answer in a message
            instead.
          </HelperText>
        ) : (
          request.proposedScopes.map((entry) => (
            <Label
              key={entry.scope}
              htmlFor={`answer-scope-${entry.scope}`}
              className="flex items-center gap-2"
            >
              <input
                id={`answer-scope-${entry.scope}`}
                type="checkbox"
                checked={chosen.includes(entry.scope)}
                onChange={() => toggle(entry.scope)}
              />
              {entry.label || entry.scope}
            </Label>
          ))
        )}
      </fieldset>

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
            disabled={busy || chosen.length === 0}
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
            onClick={() => void run((token) => AnswerRequestService.decline(token, request.requestId))}
          >
            Don&apos;t allow
          </Button>
        }
      />

      {/* Drive's price sheet, unchanged. paymentRequired is always true here:
          a paid answer with no price is not a thing this lane can express. */}
      <DocumentRequestPriceSheet
        open={priceOpen}
        requesterLabel={requesterLabel}
        purpose={request.question}
        periodStart={request.periodStart}
        periodEnd={request.periodEnd}
        paymentRequired
        busy={busy}
        error={error}
        onSubmit={approve}
        onCancel={() => setPriceOpen(false)}
      />
    </div>
  );
}
