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

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { AuthService } from "@/lib/services/auth-service";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import {
  AnswerRequestService,
  type PendingAnswerRequest,
} from "@/lib/services/answer-request-service";
import { answerScopeAvailability, type AnswerScopeAvailability } from "@/lib/answers/answer-scope-availability";
import { retrieveApprovedMemoryScopes } from "@/lib/pkm/memory-scope-retrieval";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
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

function scopeLabel(scope: string, offered: PendingAnswerRequest["proposedScopes"]): string {
  const labels: Record<string, string> = {
    "attr.identity.identity_profile.full_name": "Name",
    "attr.identity.identity_profile.declared_age": "Age",
    "attr.identity.identity_profile.sex": "Sex",
    "attr.identity.identity_profile.profile_photo_url": "Profile photo",
  };
  return labels[scope] || offered.find(entry => entry.scope === scope)?.label || "Matched information";
}

export function AnswerRequestReview({
  request,
  requesterLabel,
  onResolved,
  onApproved,
}: AnswerRequestReviewProps) {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const matched = request.resolutionMode === "agent" && request.proposedScopes.length > 0;
  const proposed = matched ? request.proposedScopes.map(entry => entry.scope) : [];
  const [refreshTick, setRefreshTick] = useState(0);
  const coverageKey = JSON.stringify([request.requestId, proposed, request.periodStart, request.periodEnd, user?.uid, snapshotVaultSessionEpoch(), refreshTick]);
  const [checked, setChecked] = useState<{ key: string; value: AnswerScopeAvailability } | null>(null);
  const coverage = checked?.key === coverageKey ? checked.value : null;
  const chosen = coverage?.available ?? [];
  const period = request.periodStart && request.periodEnd ? { start: request.periodStart, end: request.periodEnd } : null;
  const termsKey = JSON.stringify([request.requestId, request.question, proposed, period]);
  const [consented, setConsented] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [pricedSelection, setPricedSelection] = useState<{ key: string; scopes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pricedSelection && pricedSelection.key !== termsKey) {
      setPriceOpen(false);
      setPricedSelection(null);
      setConsented(false);
    }
  }, [pricedSelection, termsKey]);

  useEffect(() => {
    if (!user?.uid) return;
    const owner = user.uid;
    const refresh = () => setRefreshTick(value => value + 1);
    const stop = subscribeToPkmDomainChanges(detail => {
      if (detail.userId === owner && !(detail.domain === "one_living_sources" && detail.operation === "stored")) refresh();
    });
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      stop();
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!matched) return;
    const epoch = snapshotVaultSessionEpoch();
    let stopped = false;
    const current = () => !stopped && isVaultSessionEpochCurrent(epoch);
    const inspect = async () => {
      if (!user?.uid || !isVaultUnlocked || !vaultKey || !vaultOwnerToken)
        throw new Error("Unlock your memory to check these details.");
      const idToken = await AuthService.getIdToken();
      if (!idToken) throw new Error("Sign in to check these details.");
      const identity = await AccountIdentityService.refreshIdentityForSession(user.uid, idToken, { force: true });
      if (!identity || !current()) throw new Error("Account identity unavailable.");
      const retrieval = await retrieveApprovedMemoryScopes({
        userId: user.uid, vaultKey, vaultOwnerToken,
        approvedScopes: proposed,
        ownerIdentity: { displayName: identity.display_name, email: identity.email, photoUrl: identity.photo_url },
      });
      if (current()) setChecked({ key: coverageKey, value: answerScopeAvailability({ scopes: proposed, retrieval, period }) });
    };
    void inspect().catch(() => {
      if (current()) setChecked({ key: coverageKey, value: { available: [], missing: [], unavailable: proposed } });
    });
    return () => { stopped = true; };
  // coverageKey captures the exact question, scopes, owner and vault session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverageKey, isVaultUnlocked, vaultKey, vaultOwnerToken, user?.uid]);

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
    const approvedScopes = pricedSelection?.key === termsKey ? pricedSelection.scopes : [];
    if (!consented || !matched || !approvedScopes.length) { setError("Check the available information and agree to Gemini processing before confirming."); return; }
    void run(async (token) => {
      if (!user?.uid || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) throw new Error("Unlock your memory to confirm.");
      const identity = await AccountIdentityService.refreshIdentityForSession(user.uid, token, { force: true });
      if (!identity) throw new Error("Account identity unavailable. Try again.");
      const retrieval = await retrieveApprovedMemoryScopes({
        userId: user.uid, vaultKey, vaultOwnerToken, approvedScopes,
        ownerIdentity: { displayName: identity.display_name, email: identity.email, photoUrl: identity.photo_url },
        readOwnerIdentity: async () => {
          const fresh = await AccountIdentityService.refreshIdentityForSession(user.uid, token, { force: true });
          return fresh ? { displayName: fresh.display_name, photoUrl: fresh.photo_url } : null;
        },
      });
      const fresh = answerScopeAvailability({ scopes: approvedScopes, retrieval, period });
      if (!retrieval.complete || fresh.available.length !== approvedScopes.length) throw new Error("The available information changed. Review this request again.");
      await retrieval.assertCurrent();
      await AnswerRequestService.approve(token, request.requestId, approvedScopes, amountCents, consented);
    }, true);
  };

  return (
    <div className="consent-presentation-surface min-w-0 space-y-4">
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
              {!coverage ? <HelperText as="p" role="status">Checking what is recorded in your memory…</HelperText> : (
                <div role="status" className="space-y-1">
                  {coverage.available.length > 0 && <HelperText as="p">Available for this answer: {coverage.available.map(scope => scopeLabel(scope, request.proposedScopes)).join(", ")}</HelperText>}
                  {coverage.missing.length > 0 && <HelperText as="p">Not recorded: {coverage.missing.map(scope => scopeLabel(scope, request.proposedScopes)).join(", ")}</HelperText>}
                  {coverage.unavailable.length > 0 && <HelperText as="p">Could not verify: {coverage.unavailable.map(scope => scopeLabel(scope, request.proposedScopes)).join(", ")}. This will retry when your memory changes or you reconnect.</HelperText>}
                  {coverage.available.length > 0 && (coverage.missing.length > 0 || coverage.unavailable.length > 0) && <HelperText as="p">Only the available information will be included in the priced answer.</HelperText>}
                </div>
              )}
              {/* Consent is captured here, bound to the exact question and
                  matched scopes, before a price is ever chosen. The price
                  sheet that follows asks only for the price. */}
              <Label data-consent-role="disclosure" className="flex min-h-11 items-start gap-2 py-2">
                <input
                  type="checkbox"
                  checked={consented}
                  disabled={busy}
                  onChange={event => setConsented(event.target.checked)}
                />
                I agree to Google Gemini processing this question and the available information.
              </Label>
            </>
          ) : (
            <div role="status" className="space-y-2">
              <HelperText as="p">{request.resolutionMode === null ? "Matching this question to your memory…" : "We couldn’t match this question to your memory."}</HelperText>
              {request.resolutionMode !== null && <Button data-consent-role="compact-action" data-consent-quiet-action="true" type="button" disabled={busy} onClick={() => void run(token => AnswerRequestService.retryResolution(token, request.requestId))}>Retry matching</Button>}
            </div>
          )}

          {error ? (
            <HelperText as="p" role="alert">
              {error}
            </HelperText>
          ) : null}

          <FlowActionGroup
            primary={
              <Button data-consent-role="primary-action"
                type="button"
                size="prominent"
                disabled={busy || !matched || !consented || chosen.length === 0}
                onClick={() => {
                  setPricedSelection({ key: termsKey, scopes: [...chosen] });
                  setPriceOpen(true);
                }}
              >
                Set a price
              </Button>
            }
            secondary={
              <Button data-consent-role="compact-action"
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
        deliveryDescription="One written answer"
        periodStart={request.periodStart}
        periodEnd={request.periodEnd}
        paymentRequired
        // Consent and payout management already have their own places
        // (the review step above, and Settings); the price step is price only.
        settlement={<></>}
        busy={busy}
        error={error}
        onSubmit={approve}
        onCancel={() => {
          setPriceOpen(false);
          setPricedSelection(null);
        }}
      />
    </div>
  );
}
