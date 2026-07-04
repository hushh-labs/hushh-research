"use client";

import React from "react";
import { useState } from "react";
import { Check, ExternalLink, ShieldCheck, ShieldOff, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ClarificationCard } from "@/components/one-location/redesign/clarification-card";
import type { ClientPrompt } from "@/lib/one-location/types";

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
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3">
      <p className="text-sm font-medium text-foreground/90">{summary}</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy ? "Working…" : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full bg-black/5 px-4 py-1.5 text-sm dark:bg-white/10"
        >
          Cancel
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
  if (agentId === "agent_nav") return "Nav";
  if (agentId === "agent_location") return "Location";
  if (agentId === "agent_kai") return "Kai";
  if (agentId === "agent_kyc") return "KYC";
  return agentId.replace(/^agent_/, "").replace(/_/g, " ") || "This agent";
}

function scopeDisplayName(scope: string): string {
  if (scope === "agent.nav.review") return "review your consent and privacy access";
  if (scope === "agent.location.manage") return "manage One Location requests";
  if (scope === "agent.one.orchestrate") return "coordinate specialist agents";
  return scope || "the required permission";
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
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#6b8f71]/10 text-[#426548]">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
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
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
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
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#6b8f71]/10 text-[#426548]">
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
                    Revoke
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

export type SpecialistPendingConsentRequestItem = {
  id: string;
  requesterLabel: string;
  requesterImageUrl?: string | null;
  requesterWebsiteUrl?: string | null;
  scope: string;
  scopeDescription?: string | null;
  requestedAt?: number | string | null;
  approvalTimeoutAt?: number | string | null;
  expiryHours?: number | string | null;
  reason?: string | null;
  additionalAccessSummary?: string | null;
  status?: "pending" | "approved" | "denied";
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

export function SpecialistPendingConsentRequestCard({
  item,
  busy,
  onApprove,
  onDeny,
  onDetails,
}: SpecialistPendingConsentRequestCardProps) {
  const timeout = formatConsentTime(item.approvalTimeoutAt);
  const resolved = item.status === "approved" || item.status === "denied";
  const access = item.scopeDescription || item.scope || "requested context";
  const requester = item.requesterLabel || "An agent";

  return (
    <div
      data-testid="specialist-pending-consent-request-card"
      className="rounded-2xl border border-[#6b8f71]/35 bg-[#6b8f71]/5 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#6b8f71]/10 text-[#426548]">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">Consent request</p>
            {item.status === "approved" ? (
              <span className="rounded-full border border-[#6b8f71]/25 bg-[#6b8f71]/10 px-2 py-0.5 text-[11px] font-medium text-[#426548]">
                Approved
              </span>
            ) : item.status === "denied" ? (
              <span className="rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                Denied
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-foreground/75">
            {requester} is asking for {access}.
          </p>
          {item.additionalAccessSummary ? (
            <p className="mt-2 text-sm text-foreground/70">{item.additionalAccessSummary}</p>
          ) : null}
          {item.reason ? (
            <p className="mt-2 text-xs text-foreground/55">Reason: {item.reason}</p>
          ) : null}
          {timeout ? (
            <p className="mt-1 text-xs font-medium text-foreground/55">
              Review by {timeout}.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {resolved ? null : (
          <>
            <Button
              data-testid="specialist-pending-consent-approve"
              size="sm"
              disabled={busy}
              isLoading={busy}
              onClick={() => onApprove(item)}
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Approve
            </Button>
            <Button
              data-testid="specialist-pending-consent-deny"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onDeny(item)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Deny
            </Button>
          </>
        )}
        <Button
          data-testid="specialist-pending-consent-details"
          size="sm"
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
