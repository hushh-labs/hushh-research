"use client";

/**
 * One row in the Consent Center's Requests list.
 *
 * The row is one button: tapping it (or Enter / Space on it) opens the
 * request's sheet straight away. A grouped request used to expand in place
 * into a nested list with a "Review" on every item, and only a second tap on
 * an item opened the sheet; the sheet already decides the whole request, so
 * the expansion was a detour.
 *
 * A request that can be decided inline carries Don't allow (✗) and Allow (✓)
 * on the row itself. They sit beside the row's button, never inside it, so a
 * tap on either one never opens the sheet.
 */

import type { ReactNode } from "react";

import {
  Check,
  DeveloperToolsProfileIcon,
  RiaAgentIcon,
  X,
} from "@/components/icons";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/components/ui/button";
import { resolveConsentRequesterLabel } from "@/lib/consent/consent-display";
import {
  consentEntryInformationLabel,
  consentInformationLabel,
} from "@/lib/consent/consent-owner-copy";
import { SEMANTIC_ROLE_CLASSES } from "@/lib/morphy-ux/tokens/semantic-roles";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import { cn } from "@/lib/utils";

const ALLOW_ROLE = SEMANTIC_ROLE_CLASSES.success;
const DECLINE_ROLE = SEMANTIC_ROLE_CLASSES.neutral;

export function resolveCounterpartLabel(entry: ConsentCenterEntry): string {
  return resolveConsentRequesterLabel({
    counterpartLabel: entry.counterpart_label,
    counterpartEmail: entry.counterpart_email,
    counterpartSecondaryLabel: entry.counterpart_secondary_label,
    counterpartId: entry.counterpart_id,
  });
}

/**
 * Who is asking, drawn the way the rest of One draws them.
 *
 * A person (or anyone with a photo) is their face or initials, exactly as the
 * Feed's "Needs you" row and the owner's chat card show them. An advisor or an
 * app with no photo is its /one registry glyph, bare on a transparent well:
 * never a tinted tile around a generic silhouette.
 */
export function ConsentCounterpartAvatar({
  entry,
}: {
  entry: ConsentCenterEntry;
}) {
  const label = resolveCounterpartLabel(entry);
  const photoUrl = entry.counterpart_image_url?.trim() || null;
  const Glyph =
    entry.counterpart_type === "ria"
      ? RiaAgentIcon
      : entry.counterpart_type === "developer"
        ? DeveloperToolsProfileIcon
        : null;

  if (!Glyph || photoUrl) {
    return (
      <ConnectionPersonAvatar
        label={label}
        photoUrl={photoUrl}
        size="list"
        className="bg-[color:var(--app-neutral-fill)] text-[13px] font-semibold text-[color:var(--app-secondary-label)]"
        testId="consent-counterpart-avatar"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      data-testid="consent-counterpart-avatar"
      className="inline-flex size-10 shrink-0 items-center justify-center"
    >
      <Glyph className="size-7" />
    </span>
  );
}

/**
 * What a grouped request asks for, in one line: "Food preferences", or
 * "Food preferences and 2 more". Only the items still waiting are named; the
 * sheet lists each one.
 */
export function pendingBundleSummary(entry: ConsentCenterEntry): string {
  if (!entry.bundle_complete) return "Still arriving";
  const items = entry.bundle_items || [];
  const waiting = items.filter((item) => item.status === "pending");
  const named = (waiting.length ? waiting : items).map((item) =>
    item.entry
      ? consentEntryInformationLabel({
          ...item.entry,
          scope_description: item.label || item.entry.scope_description,
        })
      : consentInformationLabel({ label: item.label }),
  );
  const labels = [...new Set(named)];
  if (labels.length <= 1) return labels[0] ?? "Nothing waiting";
  return `${labels[0]} and ${labels.length - 1} more`;
}

/** The entry a grouped row opens: the first item still waiting. */
export function bundleEntryToOpen(
  entry: ConsentCenterEntry,
): ConsentCenterEntry | null {
  const items = entry.bundle_items || [];
  const waiting = items.find((item) => item.status === "pending" && item.entry);
  return waiting?.entry ?? items.find((item) => item.entry)?.entry ?? null;
}

export interface ConsentRowDecision {
  onAllow: () => void;
  onDecline: () => void;
  disabled?: boolean;
}

export function ConsentRowDecisionButtons({
  decision,
}: {
  decision: ConsentRowDecision;
}) {
  return (
    <div
      data-slot="consent-row-decisions"
      className="flex shrink-0 items-center gap-1.5"
    >
      <Button
        type="button"
        size="icon-touch"
        variant="secondary"
        aria-label="Don't allow"
        disabled={decision.disabled}
        onClick={(event) => {
          event.stopPropagation();
          decision.onDecline();
        }}
        className={cn(DECLINE_ROLE.tile, DECLINE_ROLE.glyph)}
      >
        <X className="size-5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-touch"
        variant="secondary"
        aria-label="Allow"
        disabled={decision.disabled}
        onClick={(event) => {
          event.stopPropagation();
          decision.onAllow();
        }}
        className={cn(
          ALLOW_ROLE.tile,
          ALLOW_ROLE.glyph,
          "hover:bg-[color:var(--app-success-surface)]",
        )}
      >
        <Check className="size-5" aria-hidden="true" />
      </Button>
    </div>
  );
}

export function ConsentPendingRequestRow({
  entry,
  summary,
  selected,
  onOpen,
  decision,
  fallbackTrailing,
}: {
  entry: ConsentCenterEntry;
  /** "Food preferences", "Food preferences and 2 more", "Still arriving". */
  summary: string;
  selected: boolean;
  /** Opens the sheet. Absent only when there is nothing to open yet. */
  onOpen?: () => void;
  /** Present when the request can be decided from the row. */
  decision?: ConsentRowDecision | null;
  /** Shown instead of ✗ / ✓ when the row cannot decide (a status badge). */
  fallbackTrailing?: ReactNode;
}) {
  const counterpart = resolveCounterpartLabel(entry);
  const subtitle =
    entry.counterpart_email || entry.counterpart_secondary_label || null;
  const isBundle = Boolean(entry.bundle_items);
  return (
    <SettingsRow
      testId={isBundle ? "consent-bundle-row" : "consent-entry-row"}
      // The person-list rhythm (40px face, 68px text start). It is also the
      // split row without a second inner padding: the settings layout pads
      // the row AND its button, which left a 34px name column at 320px.
      layout="person"
      onClick={onOpen}
      ariaLabel={onOpen ? `${counterpart}, ${summary}, review` : undefined}
      leading={<ConsentCounterpartAvatar entry={entry} />}
      title={counterpart}
      description={
        <span className="line-clamp-2">
          <span>{summary}</span>
          {subtitle ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{subtitle}</span>
            </>
          ) : null}
        </span>
      }
      trailing={
        decision ? (
          <ConsentRowDecisionButtons decision={decision} />
        ) : (
          fallbackTrailing
        )
      }
      trailingInteractive={Boolean(decision)}
      chevron={!decision && !fallbackTrailing && Boolean(onOpen)}
      className={selected ? "bg-accent-surface" : undefined}
    />
  );
}
