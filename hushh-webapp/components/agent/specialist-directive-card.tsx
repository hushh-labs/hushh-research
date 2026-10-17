"use client";

import React from "react";
import { useEffect, useState } from "react";
import { ConsentAgentIcon, ExternalLink, ShieldCheck, ShieldOff } from "@/components/icons";

import { Button } from "@/components/ui/button";
import { ClarificationCard } from "@/components/one-location/redesign/clarification-card";
import type { ClientPrompt } from "@/lib/one-location/types";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { ConnectorBrandMark, type ConnectorBrand } from "@/components/agent/connector-brand-mark";

// ─── Action mode (existing contract, unchanged) ───────────────────────────────

export type SpecialistCardProps = {
  summary: string;
  brand?: ConnectorBrand;
  /** Exact reviewed terms, one labelled line each, shown under the summary. */
  details?: { label: string; value: string }[];
  /** Exact items the action touches (e.g. one line per email), shown for review. */
  items?: string[];
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Replaces "Working…" while busy, e.g. while a Google sign-in window is open. */
  busyLabel?: string;
  /** Keeps Cancel available while busy, so an open sign-in can be abandoned. */
  cancelWhileBusy?: boolean;
};

export function SpecialistDirectiveCard({
  summary,
  brand,
  details,
  items,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
  busyLabel,
  cancelWhileBusy = false,
}: SpecialistCardProps) {
  return (
    <div
      className="rounded-2xl border border-primary/20 bg-primary/5 p-3"
      data-testid="specialist-directive-card"
    >
      <div className="flex items-center gap-3">
        {brand ? <ConnectorBrandMark brand={brand} /> : null}
        <p className="min-w-0 text-sm font-medium text-foreground/90">{summary}</p>
      </div>
      {details && details.length > 0 ? (
        <dl className="mt-2 space-y-1 text-sm" data-testid="specialist-directive-details">
          {details.map((line) => (
            <div key={line.label} className="flex gap-2">
              <dt className="shrink-0 text-foreground/55">{line.label}</dt>
              <dd className="min-w-0 break-words font-medium text-foreground/90">
                {line.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {items && items.length > 0 ? (
        <ul
          className="mt-2 space-y-1 text-xs text-foreground/70"
          data-testid="specialist-directive-items"
        >
          {items.map((item, index) => (
            <li key={index} className="truncate">
              {item}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="relative rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
          data-testid="specialist-directive-confirm"
        >
          {busy ? busyLabel ?? "Working…" : confirmLabel}
          <MaterialRipple variant="none" effect="fill" disabled={busy} />
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy && !cancelWhileBusy}
          className="relative rounded-full bg-black/5 px-4 py-1.5 text-sm dark:bg-white/10"
          data-testid="specialist-directive-cancel"
        >
          Cancel
          <MaterialRipple variant="none" effect="glass" disabled={busy && !cancelWhileBusy} />
        </button>
      </div>
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
      className="rounded-2xl border border-primary/20 bg-primary/5 p-4"
    >
      <p className="text-sm font-medium">{question}</p>
      <textarea
        className="mt-3 min-h-20 w-full resize-none rounded-xl border border-[color:var(--app-card-border-standard)] bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
        placeholder={placeholder || undefined}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="mt-3 flex gap-2">
        <Button
          data-testid="specialist-free-text-submit"
          size="sm"
          isLoading={busy}
          disabled={busy || !trimmed}
          onClick={() => onSubmit(trimmed)}
        >
          {confirmLabel ?? "Continue"}
        </Button>
        <Button
          data-testid="specialist-free-text-cancel"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel ?? "Cancel"}
        </Button>
      </div>
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
      className="rounded-2xl border border-[#6b8f71]/35 bg-[#6b8f71]/5 p-4"
    >
      <div className="flex items-start gap-3">
        {/* The /one Consent glyph, bare on a transparent well: never a tile. */}
        <div data-slot="card-header-icon" className="grid h-9 w-9 shrink-0 place-items-center">
          <ConsentAgentIcon className="h-7 w-7" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{agentName} needs permission</p>
          <p className="mt-1 text-sm text-foreground/75">
            Allow {agentName} to {scopeName} before it continues in this chat.
          </p>
          {reason ? <p className="mt-2 text-xs text-foreground/55">{reason}</p> : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          data-testid="specialist-consent-open"
          size="sm"
          disabled={busy}
          onClick={onOpenConsent}
        >
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Review access
        </Button>
        <Button
          data-testid="specialist-consent-cancel"
          size="sm"
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
      className="rounded-2xl border border-[#6b8f71]/35 bg-[#6b8f71]/5 p-4"
    >
      <div className="flex items-start gap-3">
        {/* The /one Consent glyph, bare on a transparent well: never a tile. */}
        <div data-slot="card-header-icon" className="grid h-9 w-9 shrink-0 place-items-center">
          <ConsentAgentIcon className="h-7 w-7" aria-hidden="true" />
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
                <p className="mt-1 text-xs font-medium text-foreground/55">
                  Until {expiry}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {actions.has("revoke") ? (
                  <Button
                    data-testid="specialist-consent-revoke"
                    size="sm"
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
                    size="sm"
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
                    size="sm"
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
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import {
  consentInformationLabel,
  consentRequestHeadline,
  formatConsentDuration,
  formatDecideBy,
  requesterShortName,
} from "@/lib/consent/consent-owner-copy";
import { useArmedAction } from "@/lib/ui/use-armed-action";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

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

// The owner's words for a request that is no longer waiting, the same words
// the Feed and the Consent Center use for it.
const resolvedConsentLabels: Record<Exclude<PendingConsentCardStatus, "pending">, string> = {
  approved: "Allowed", denied: "Not allowed", cancelled: "Withdrawn",
  expired: "Expired", revoked: "Sharing stopped", unavailable: "Status unavailable",
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

/**
 * The wire carries hours as a number or a string, or not at all. Only a
 * positive, finite count becomes words, and the words are the one duration
 * wording every consent surface shares.
 */
function pendingDurationLabel(hours?: number | string | null): string | null {
  if (hours == null || hours === "") return null;
  const numeric = typeof hours === "number" ? hours : Number(hours);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return formatConsentDuration(Math.round(numeric));
}

/** The human names of what this card asks for, one per item. */
function pendingConsentLabels(item: SpecialistPendingConsentRequestItem): string[] {
  const bundled = (item.bundledScopes || [])
    .map((scope) => consentInformationLabel({ label: scope.label }))
    .filter(Boolean);
  if (bundled.length > 1) return bundled;
  return [consentInformationLabel({ scope: item.scope, label: item.scopeDescription })];
}

/**
 * The owner's own pending request in chat, worded and laid out like the Feed's
 * "Needs you" row: who wants what and why, then Details, Don't allow and Allow.
 * The buttons call back into the chat workspace, which decides through the
 * same shared approve path as the Feed and the Consent Center.
 */
export function SpecialistPendingConsentRequestCard({
  item,
  busy,
  onApprove,
  onDeny,
  onDetails,
}: SpecialistPendingConsentRequestCardProps) {
  const duration = pendingDurationLabel(item.expiryHours);
  const decideBy = formatDecideBy(item.approvalTimeoutAt);
  const status = normalizePendingConsentCardStatus(item.status);
  const resolved = status !== "pending";

  // Don't allow is irreversible, so it takes a confirming second tap: the
  // first tap arms the button ("Sure?") and it disarms on its own a few
  // seconds later, so a stray tap cannot turn someone down. One
  // implementation, shared with the feed's actionable row.
  const denyTap = useArmedAction();
  const { armed: denyArmed, disarm: disarmDeny } = denyTap;

  // Allow locks the row; a Don't allow left armed underneath it must not fire
  // once the row unlocks.
  useEffect(() => {
    if (busy || resolved) disarmDeny();
  }, [busy, resolved, disarmDeny]);

  const requester = item.requesterLabel || "Someone";
  const labels = pendingConsentLabels(item);
  const headline = consentRequestHeadline({
    // First name for a person, the whole name for an app or an advisor.
    requesterShortName: requesterShortName(
      requester,
      item.metadata?.requester_actor_type === "person",
    ),
    labels,
  });
  const meta = [
    duration ? `For ${duration}` : null,
    !resolved && decideBy ? `Decide by ${decideBy}` : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div
      data-testid="specialist-pending-consent-request-card"
      className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4"
    >
      <div className="flex items-start gap-3">
        <ConnectionPersonAvatar
          label={requester}
          photoUrl={item.requesterImageUrl ?? null}
          size="list"
          className="bg-[color:var(--app-neutral-fill)] text-[13px] font-semibold text-[color:var(--app-secondary-label)]"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[15px] font-semibold leading-5 text-foreground [overflow-wrap:anywhere]">
            {headline}
          </p>
          {item.reason ? (
            <p className="text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              {item.reason}
            </p>
          ) : null}
          {item.additionalAccessSummary ? (
            <p className="text-sm leading-5 text-muted-foreground">
              {item.additionalAccessSummary}
            </p>
          ) : null}
          {meta.length ? (
            <p
              className="text-[13px] leading-[18px] text-muted-foreground"
              data-testid="specialist-pending-consent-duration"
            >
              {meta.join(" · ")}
            </p>
          ) : null}
          {resolved ? (
            <p
              className="text-[13px] font-semibold leading-[18px] text-muted-foreground"
              data-testid="specialist-pending-consent-status"
            >
              {resolvedConsentLabels[status]}
            </p>
          ) : null}
          {labels.length > 3 ? (
            <div className="pt-2">
              <ConsentScopeList
                items={item.bundledScopes || []}
                groupByDomain={false}
                collapsible={false}
                testIdPrefix="pending-consent-scopes"
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          data-testid="specialist-pending-consent-details"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onDetails(item)}
        >
          Details
        </Button>
        {resolved ? null : (
          <>
            <Button
              data-testid="specialist-pending-consent-deny"
              size="sm"
              variant={denyArmed ? "destructive" : "ghost"}
              disabled={busy}
              aria-label={denyTap.ariaLabel("Don't allow")}
              data-armed={denyArmed ? "true" : undefined}
              onClick={() => {
                if (busy) return;
                denyTap.activate(() => onDeny(item));
              }}
            >
              {denyTap.label("Don't allow")}
            </Button>
            <Button
              data-testid="specialist-pending-consent-approve"
              size="sm"
              disabled={busy}
              isLoading={busy}
              onClick={() => onApprove(item)}
            >
              Allow
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
