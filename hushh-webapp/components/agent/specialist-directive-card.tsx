"use client";

import React from "react";
import { useEffect, useState } from "react";
import { Check, ExternalLink, ShieldCheck, ShieldOff, X } from "@/components/icons";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { ClarificationCard } from "@/components/one-location/redesign/clarification-card";
import type { ClientPrompt } from "@/lib/one-location/types";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";

// ─── Action mode (existing contract, unchanged) ───────────────────────────────

export type SpecialistCardProps = {
  summary: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
};

export function SpecialistDirectiveCard({
  summary,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: SpecialistCardProps) {
  return (
    <div
      className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-settings-border)] bg-[color:var(--app-settings-surface)] p-4"
      data-testid="specialist-directive-card"
    >
      <p className="text-sm font-medium text-foreground/90">{summary}</p>
      <FlowActionGroup
        className="mt-4"
        primary={
          <Button
            type="button"
            size="prominent"
            className="h-auto max-w-full whitespace-normal py-3 text-center [overflow-wrap:anywhere]"
            onClick={onConfirm}
            disabled={busy}
            isLoading={busy}
            data-testid="specialist-directive-confirm"
          >
            {confirmLabel}
          </Button>
        }
        secondary={
          <Button
            type="button"
            size="standard"
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
            data-testid="specialist-directive-cancel"
          >
            Cancel
          </Button>
        }
      />
    </div>
  );
}

// ─── Prompt mode (disambiguation / selection) ─────────────────────────────────
// Reuses the proven ClarificationCard from the one-location redesign so the
// rendering, option-toggle, and free-text logic are a single implementation.

export type SpecialistPromptCardProps = {
  prompt: ClientPrompt;
  busy?: boolean;
  onAnswer: (refs: Record<string, unknown>[]) => void;
  onConfirm: (yes: boolean) => void;
  onCancel: () => void;
};

export function SpecialistPromptCard({
  prompt,
  busy = false,
  onAnswer,
  onConfirm,
  onCancel,
}: SpecialistPromptCardProps) {
  return (
    <ClarificationCard
      prompt={prompt}
      busy={busy}
      onAnswer={onAnswer}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export type SpecialistFreeTextPromptCardProps = {
  question: string;
  placeholder?: string | null;
  confirmLabel?: string | null;
  cancelLabel?: string | null;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

export function SpecialistFreeTextPromptCard({
  question,
  placeholder,
  confirmLabel,
  cancelLabel,
  busy = false,
  onSubmit,
  onCancel,
}: SpecialistFreeTextPromptCardProps) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  return (
    <div
      data-testid="specialist-free-text-prompt-card"
      className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-settings-border)] bg-[color:var(--app-settings-surface)] p-4"
    >
      <p className="text-sm font-medium">{question}</p>
      <Textarea
        aria-label={question}
        className="mt-3 min-h-24 w-full resize-y"
        placeholder={placeholder || undefined}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
      />
      <FlowActionGroup
        className="mt-4"
        primary={
          <Button
            data-testid="specialist-free-text-submit"
            size="prominent"
            className="h-auto max-w-full whitespace-normal py-3 text-center [overflow-wrap:anywhere]"
            isLoading={busy}
            disabled={busy || !trimmed}
            onClick={() => onSubmit(trimmed)}
          >
            {confirmLabel ?? "Continue"}
          </Button>
        }
        secondary={
          <Button
            data-testid="specialist-free-text-cancel"
            size="standard"
            variant="secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel ?? "Cancel"}
          </Button>
        }
      />
    </div>
  );
}

// ─── Consent-required mode ───────────────────────────────────────────────────

export type SpecialistConsentRequiredCardProps = {
  agentId: string;
  requiredScope: string;
  reason?: string | null;
  busy?: boolean;
  onOpenConsent: () => void;
  onCancel: () => void;
};

function agentDisplayName(agentId: string): string {
  if (agentId === "agent_email") return "Mail";
  if (agentId === "agent_nav") return "Nav";
  if (agentId === "agent_location") return "Location";
  if (agentId === "agent_kai") return "Finance";
  if (agentId === "agent_kyc") return "KYC";
  return agentId.replace(/^agent_/, "").replace(/_/g, " ") || "This agent";
}

/**
 * What a specialist may require, said in the owner's words.
 *
 * The five keys mirror SPECIALIST_A2A_SCOPE_MAP in
 * consent-protocol/hushh_mcp/adk_bridge/delegation.py. Anything else falls
 * back to a plain phrase rather than the raw identifier: agent.yaml forbids
 * the model from reading our plumbing out loud, and the chrome used to undo
 * that by printing "agent.kyc.process" mid-sentence.
 */
function scopeDisplayName(scope: string): string {
  if (scope === "agent.nav.review") return "review your sharing";
  if (scope === "agent.kai.analyze") return "look at your finances";
  if (scope === "agent.kyc.process") return "run your identity check";
  if (scope === "cap.pkm.marketplace.view") return "see what you have made available";
  if (scope === "cap.one.invoke") return "act for you in the app";
  if (scope === "agent.location.manage") return "manage Location requests";
  if (scope === "agent.one.orchestrate") return "coordinate specialist agents";
  return "the permission it needs";
}

export function SpecialistConsentRequiredCard({
  agentId,
  requiredScope,
  reason,
  busy,
  onOpenConsent,
  onCancel,
}: SpecialistConsentRequiredCardProps) {
  const agentName = agentDisplayName(agentId);
  const scopeName = scopeDisplayName(requiredScope);

  return (
    <div
      data-testid="specialist-consent-required-card"
      className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-settings-border)] bg-[color:var(--app-settings-surface)] p-4"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[color:var(--app-settings-icon-surface)] text-[color:var(--app-settings-icon-foreground)]">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{agentName} needs permission</p>
          <p className="mt-1 text-sm text-foreground/75">
            Allow {agentName} to {scopeName} before it continues in this chat.
          </p>
          {reason ? <p className="mt-2 text-xs text-muted-foreground">{reason}</p> : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 [&>button]:w-full sm:[&>button]:w-auto">
        <Button
          data-testid="specialist-consent-open"
          size="compact"
          disabled={busy}
          onClick={onOpenConsent}
        >
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Review access
        </Button>
        <Button
          data-testid="specialist-consent-cancel"
          size="compact"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── Consent actions mode ────────────────────────────────────────────────────

export type SpecialistConsentActionItem = {
  id: string;
  label: string;
  summary?: string | null;
  scope?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
  actions?: string[];
  status?: "active" | "revoked" | string | null;
};

export type SpecialistConsentActionsCardProps = {
  items: SpecialistConsentActionItem[];
  busyItemId?: string | null;
  onRevoke: (item: SpecialistConsentActionItem) => void;
  onDetails: (item: SpecialistConsentActionItem) => void;
};

function formatConsentExpiry(value?: string | null): string | null {
  return formatLocalDateTime(value);
}

function consentActionSet(item: SpecialistConsentActionItem): Set<string> {
  const actions = new Set(item.actions ?? []);
  if (item.status === "revoked") {
    actions.delete("revoke");
    actions.add("details");
    return actions;
  }

  const requestSource =
    typeof item.metadata?.request_source === "string"
      ? item.metadata.request_source.trim()
      : "";
  const isLocationGrant =
    item.id.startsWith("one_location_grant:") ||
    requestSource === "one_location_share_grant" ||
    String(item.scope || "").startsWith("cap.location.");

  if (isLocationGrant) {
    actions.add("revoke");
    actions.add("details");
  }

  return actions;
}

export function SpecialistConsentActionsCard({
  items,
  busyItemId,
  onRevoke,
  onDetails,
}: SpecialistConsentActionsCardProps) {
  if (items.length === 0) return null;

  return (
    <div
      data-testid="specialist-consent-actions-card"
      className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-settings-border)] bg-[color:var(--app-settings-surface)] p-4"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[color:var(--app-settings-icon-surface)] text-[color:var(--app-settings-icon-foreground)]">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Manage access</p>
          <p className="mt-1 text-sm text-foreground/75">
            Review or revoke approved access directly from this chat.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {items.map((item) => {
          const actions = consentActionSet(item);
          const busy = busyItemId === item.id;
          const revoked = item.status === "revoked";
          const expiry = formatConsentExpiry(item.expiresAt);
          return (
            <div
              key={item.id}
              className={
                revoked
                  ? "rounded-xl border border-black/10 bg-black/[0.025] p-3 opacity-80 dark:border-white/10 dark:bg-white/[0.03]"
                  : "rounded-xl border border-black/10 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.04]"
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                {revoked ? (
                  <span className="rounded-full border border-black/10 bg-black/[0.04] px-2 py-0.5 text-[11px] font-medium text-foreground/60 dark:border-white/10 dark:bg-white/[0.06]">
                    Revoked
                  </span>
                ) : null}
              </div>
              {item.summary ? (
                <p className="mt-1 text-sm text-foreground/70">{item.summary}</p>
              ) : null}
              {expiry ? (
                <p className="mt-1 text-xs font-medium text-muted-foreground">
                  Until {expiry}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {actions.has("revoke") ? (
                  <Button
                    data-testid="specialist-consent-revoke"
                    size="compact"
                    variant="destructive"
                    disabled={busy}
                    isLoading={busy}
                    onClick={() => onRevoke(item)}
                  >
                    <ShieldOff className="h-4 w-4" aria-hidden="true" />
                    Stop sharing
                  </Button>
                ) : null}
                {revoked ? (
                  <Button
                    data-testid="specialist-consent-revoked"
                    size="compact"
                    variant="ghost"
                    disabled
                  >
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    Revoked
                  </Button>
                ) : null}
                {actions.has("details") ? (
                  <Button
                    data-testid="specialist-consent-details"
                    size="compact"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => onDetails(item)}
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    Details
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Pending consent request mode ────────────────────────────────────────────

import type { ConsentScopeItem } from "@/lib/consent/consent-scope-items";
import { ConsentScopeList } from "@/components/consent/consent-scope-list";
import { requestDurationLabel } from "@/lib/agent/action-directive-summary";
import { useArmedAction } from "@/lib/ui/use-armed-action";

export type PendingConsentCardStatus =
  | "pending" | "approved" | "denied" | "cancelled"
  | "expired" | "revoked" | "unavailable";

export function normalizePendingConsentCardStatus(value: unknown): PendingConsentCardStatus {
  if (value == null) return "pending";
  switch (value) {
    case "pending": case "approved": case "denied": case "cancelled":
    case "expired": case "revoked": case "unavailable":
      return value as PendingConsentCardStatus;
    default:
      return "unavailable";
  }
}

const resolvedConsentLabels: Record<Exclude<PendingConsentCardStatus, "pending">, string> = {
  approved: "Approved", denied: "Denied", cancelled: "Withdrawn",
  expired: "Expired", revoked: "Revoked", unavailable: "Status unavailable",
};

export type SpecialistPendingConsentRequestItem = {
  id: string;
  requesterLabel: string;
  requesterImageUrl?: string | null;
  requesterWebsiteUrl?: string | null;
  scope: string;
  scopeDescription?: string | null;
  requestedAt?: number | string | null;
  approvalTimeoutAt?: number | string | null;
  /** How long the access would last once allowed, in whole hours. */
  expiryHours?: number | string | null;
  /** The request's wire metadata, carried so the details sheet can read it. */
  metadata?: Record<string, unknown> | null;
  reason?: string | null;
  additionalAccessSummary?: string | null;
  status?: PendingConsentCardStatus;
  /**
   * The request this one arrived as part of.
   *
   * The backend writes one consent event PER SCOPE, correctly: a grant and a
   * revocation are per-scope security decisions. But someone who asked for
   * fourteen things asked ONE question, and answering fourteen separate cards
   * with fourteen Approve buttons is not that question. These three fields were
   * always on the wire and were dropped by the mapper, so chat could not tell
   * that fourteen cards were one ask.
   *
   * Only the decision surface bundles. The authority underneath is unchanged.
   */
  bundleId?: string | null;
  bundleLabel?: string | null;
  bundleScopeCount?: number | null;
  /** Every request id folded into this card, including this one. */
  bundledRequestIds?: string[];
  /** One row per thing being asked for, when this card represents several. */
  bundledScopes?: ConsentScopeItem[];
};

export type SpecialistPendingConsentRequestCardProps = {
  item: SpecialistPendingConsentRequestItem;
  busy?: boolean;
  onApprove: (item: SpecialistPendingConsentRequestItem) => void;
  onDeny: (item: SpecialistPendingConsentRequestItem) => void;
  onDetails: (item: SpecialistPendingConsentRequestItem) => void;
};

function formatConsentTime(value?: number | string | null): string | null {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * The wire carries hours as a number or a string, or not at all. Only a
 * positive, finite count becomes a sentence; the words come from the same
 * helper the request sheet used, so both ends of one ask read alike.
 */
function pendingDurationLabel(hours?: number | string | null): string | null {
  if (hours == null || hours === "") return null;
  const numeric = typeof hours === "number" ? hours : Number(hours);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return requestDurationLabel(Math.round(numeric));
}

export function SpecialistPendingConsentRequestCard({
  item,
  busy,
  onApprove,
  onDeny,
  onDetails,
}: SpecialistPendingConsentRequestCardProps) {
  const timeout = formatConsentTime(item.approvalTimeoutAt);
  const duration = pendingDurationLabel(item.expiryHours);
  const status = normalizePendingConsentCardStatus(item.status);
  const resolved = status !== "pending";

  // Deny is irreversible, so it takes a confirming second tap: the first tap
  // arms the button ("Sure?") and it disarms on its own a few seconds later,
  // so a stray tap cannot turn someone down. One implementation, shared with
  // the feed's actionable row.
  const denyTap = useArmedAction();
  const { armed: denyArmed, disarm: disarmDeny } = denyTap;

  // Approve locks the row; a Deny left armed underneath it must not fire once
  // the row unlocks.
  useEffect(() => {
    if (busy || resolved) disarmDeny();
  }, [busy, resolved, disarmDeny]);
  const access = item.scopeDescription || item.scope || "requested context";
  // How many things this one card now stands for. The bundle merge folds
  // same-bundle requests together, so this grows as they arrive.
  const bundledCount = item.bundledScopes?.length || 1;
  const requester = item.requesterLabel || "An agent";

  return (
    <div
      data-testid="specialist-pending-consent-request-card"
      className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-settings-border)] bg-[color:var(--app-settings-surface)] p-4"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[color:var(--app-settings-icon-surface)] text-[color:var(--app-settings-icon-foreground)]">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">
              {/* Not "Consent request". agent.yaml bans that vocabulary for the
                  model's speech; the chrome should not undo it one line later. */}
              {bundledCount > 1
                ? `${requester} wants to see ${bundledCount} things`
                : `${requester} wants to see something`}
            </p>
            {status === "approved" ? (
              <span className="rounded-full bg-[color:var(--app-settings-icon-surface)] px-2 py-0.5 text-xs font-medium text-[color:var(--app-settings-icon-foreground)]">
                Approved
              </span>
            ) : status === "denied" ? (
              <span className="rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                Denied
              </span>
            ) : status !== "pending" ? (
              <span className="text-xs font-medium text-muted-foreground">
                {resolvedConsentLabels[status]}
              </span>
            ) : null}
          </div>
          {bundledCount > 1 ? (
            <p className="mt-1 text-sm text-foreground/75">
              They are asking for these. You decide together, once.
            </p>
          ) : (
            <p className="mt-1 text-sm text-foreground/75">
              {requester} is asking for {access}.
            </p>
          )}
          {bundledCount > 1 ? (
            <div className="mt-3">
              <ConsentScopeList
                items={item.bundledScopes || []}
                groupByDomain={false}
                collapsible={false}
                testIdPrefix="pending-consent-scopes"
              />
            </div>
          ) : null}
          {duration ? (
            <p
              className="mt-2 text-sm text-foreground/75"
              data-testid="specialist-pending-consent-duration"
            >
              For {duration}.
            </p>
          ) : null}
          {item.additionalAccessSummary ? (
            <p className="mt-2 text-sm text-foreground/70">{item.additionalAccessSummary}</p>
          ) : null}
          {item.reason ? (
            <p className="mt-2 text-xs text-muted-foreground">Reason: {item.reason}</p>
          ) : null}
          {timeout ? (
            <p className="mt-1 text-xs font-medium text-muted-foreground">
              Review by {timeout}.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 [&>button]:w-full sm:[&>button]:w-auto">
        {resolved ? null : (
          <>
            <Button
              data-testid="specialist-pending-consent-approve"
              size="compact"
              disabled={busy}
              isLoading={busy}
              onClick={() => onApprove(item)}
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Approve
            </Button>
            <Button
              data-testid="specialist-pending-consent-deny"
              size="compact"
              variant={denyArmed ? "destructive" : "ghost"}
              disabled={busy}
              aria-label={denyTap.ariaLabel("Deny")}
              data-armed={denyArmed ? "true" : undefined}
              onClick={() => {
                if (busy) return;
                denyTap.activate(() => onDeny(item));
              }}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              {denyTap.label("Deny")}
            </Button>
          </>
        )}
        <Button
          data-testid="specialist-pending-consent-details"
          size="compact"
          variant="ghost"
          disabled={busy}
          onClick={() => onDetails(item)}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          Details
        </Button>
      </div>
    </div>
  );
}
