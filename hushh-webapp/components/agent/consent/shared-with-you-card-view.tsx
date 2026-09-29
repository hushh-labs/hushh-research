"use client";

/**
 * The secure "Shared with you" card, as a person reads it (CONTRACT-2
 * decisions 1 and 2). One component for chat and Profile.
 *
 * This file only draws; it never opens, fetches or stores anything. The
 * container (`shared-with-you-card.tsx`) opens the values on this device and
 * passes them in; they live in React memory and nowhere else.
 *
 * Layout contract: every state (loading, locked, ready) draws the same rows at
 * the same height, so values arriving never move the card.
 */
import { useState } from "react";
import { Copy, Eye, EyeOff, Lock, LockKeyhole, RefreshCw, ShieldCheck } from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/toast-utils";
import { copyToClipboard } from "@/lib/utils/clipboard";
import { cn } from "@/lib/utils";
import { AccessEndedNotice } from "./access-ended-notice";
import { firstName, formatDay } from "./request-progress";
import { humanSharedDetails } from "./shared-details";
import {
  fieldSensitivity,
  isNamedSensitiveField,
  sensitiveFieldNameSet,
  type SharedFieldSensitivity,
} from "@/lib/consent/field-sensitivity";

export type SharedWithYouCardStatus = "loading" | "locked" | "ready" | "error";
export type SharedWithYouItemState = "loading" | "locked" | "ready" | "ended" | "unavailable" | "unopenable";

export type SharedWithYouItemView = {
  key: string;
  label: string;
  sharedAt: string | null;
  accessEndsAt: string | null;
  purpose: string | null;
  sensitive: boolean;
  /** Field names only, for the locked and loading outline. */
  fieldOutline: string[];
  /** Each field's own C7 reading, when the server sent one (names only). */
  fields?: SharedFieldSensitivity[];
  state: SharedWithYouItemState;
  endedReason?: "revoked" | "expired";
  endedAt?: string | null;
  /** Decrypted on this device; present only when `state` is "ready". */
  data?: Record<string, unknown> | null;
};

export type SharedWithYouCardViewProps = {
  person: { displayName: string; photoUrl?: string | null };
  status: SharedWithYouCardStatus;
  items: SharedWithYouItemView[];
  onUnlock?: () => void;
  onRetry?: () => void;
  /** Chat floats the card in the transcript; Profile stacks it in a list. */
  variant?: "chat" | "profile";
  className?: string;
};

/** `sensitive` marks an identifier field (an EIN) inside a standard item. */
export type SharedValueRow = { label: string | null; value: string; sensitive?: true };

/** Initialisms read as people write them: "Ein" is "EIN". */
const INITIALISMS = new Set(["ein", "ssn", "itin", "agi", "irs", "dob", "id", "zip", "iban", "swift", "vat", "gst", "pan", "llc", "w2", "w9", "url", "pin"]);

export function displayFieldLabel(label: string): string {
  return label.split(" ").map((word) => INITIALISMS.has(word.toLowerCase()) ? word.toUpperCase() : word).join(" ");
}

const MAX_OUTLINE_ROWS = 6;

/**
 * Label and value rows from a decrypted record, through the C1 renderer, which
 * already drops ids, envelope keys and structure. Its "Field: value" strings
 * are split back into a field and a value so each can be read and copied on
 * its own.
 */
export function sharedValueRows(
  data: unknown,
  heading: string,
  fields?: readonly SharedFieldSensitivity[],
): SharedValueRow[] {
  const named = sensitiveFieldNameSet(fields);
  // C7 field level, the same rule the device applies before One reads
  // anything: an identifier key or an identifier-shaped value, or a field the
  // server's `fields[]` names sensitive.
  const mark = (label: string | null, value: string): SharedValueRow => {
    const sensitive = fieldSensitivity(label ? [label] : [], value) === "sensitive"
      || isNamedSensitiveField(named, label);
    return { label: label ? displayFieldLabel(label) : null, value, ...(sensitive ? { sensitive: true as const } : {}) };
  };
  return humanSharedDetails(data, heading).flatMap((row) => row.values.map((value) => {
    const prefix = `${row.label}: `;
    if (value.startsWith(prefix)) return mark(row.label, value.slice(prefix.length));
    return mark(row.label.toLowerCase() === heading.toLowerCase() ? null : row.label, value);
  }));
}

/** "Shared Sep 28 · Access until Oct 5". */
export function sharedDatesLine(sharedAt: string | null, accessEndsAt: string | null): string | null {
  const shared = formatDay(sharedAt);
  const until = formatDay(accessEndsAt);
  const parts = [shared ? `Shared ${shared}` : null, until ? `Access until ${until}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function statusLine(status: SharedWithYouCardStatus): { text: string; icon: "lock" | "shield" } {
  switch (status) {
    case "locked": return { text: "Locked on this device", icon: "lock" };
    case "loading": return { text: "Opening on this device…", icon: "shield" };
    case "error": return { text: "Couldn’t open on this device", icon: "lock" };
    default: return { text: "Decrypted on this device", icon: "shield" };
  }
}

const ROW = "flex min-h-11 items-center gap-3 px-3.5 py-2";

function CopyValueButton({ label, value }: { label: string; value: string }) {
  return (
    <button type="button" aria-label={`Copy ${label}`}
      onClick={() => {
        void copyToClipboard(value).then((copied) => {
          if (copied) morphyToast.success("Copied", { duration: 1600 });
          else morphyToast.error("Couldn’t copy");
        });
      }}
      className="-my-1 -mr-2 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-9">
      <Copy className="size-4" aria-hidden="true" />
    </button>
  );
}

function ValueRows({ rows, hidden, itemLabel, itemSensitive }: {
  rows: SharedValueRow[];
  hidden: boolean;
  itemLabel: string;
  /** The whole item is sensitive; otherwise only rows marked `sensitive` hide. */
  itemSensitive: boolean;
}) {
  return (
    <dl className="divide-y divide-border/50" data-testid="shared-with-you-values" data-hidden={hidden ? "true" : "false"}>
      {rows.map((row, index) => {
        const masked = hidden && (itemSensitive || Boolean(row.sensitive));
        // A field-level mark only inside a standard item: a sensitive item
        // already says so once, above its rows.
        const fieldMark = !itemSensitive && Boolean(row.sensitive);
        return (
          <div key={`${row.label ?? ""}:${index}`} className={ROW} data-testid="shared-with-you-row"
            data-sensitive-field={fieldMark ? "true" : undefined}>
            <div className="min-w-0 flex-1">
              {row.label || fieldMark ? (
                <dt className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs leading-5 text-muted-foreground">
                  {row.label ? <span className="min-w-0">{row.label}</span> : null}
                  {fieldMark ? (
                    <span data-testid="shared-with-you-sensitive-field"
                      className="inline-flex shrink-0 items-center gap-1 font-medium">
                      <ShieldCheck className="size-3 shrink-0" aria-hidden="true" />
                      Sensitive
                      <span className="sr-only"> · not shared with One’s model</span>
                    </span>
                  ) : null}
                </dt>
              ) : null}
              <dd className="text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
                {masked
                  ? <span aria-label="Hidden" className="select-none tracking-[0.2em] text-muted-foreground">••••••</span>
                  : row.value}
              </dd>
            </div>
            {masked ? null : <CopyValueButton label={row.label ?? itemLabel} value={row.value} />}
          </div>
        );
      })}
    </dl>
  );
}

/** The outline of what is there, with the values masked or still arriving. */
function OutlineRows({ names, mode }: { names: string[]; mode: "locked" | "loading" | "unopenable" }) {
  const rows = names.length ? names.slice(0, MAX_OUTLINE_ROWS) : [null, null, null];
  return (
    <dl className="divide-y divide-border/50" data-testid={`shared-with-you-${mode}-outline`} aria-busy={mode === "loading"}>
      {rows.map((name, index) => (
        <div key={`${name ?? "field"}:${index}`} className={ROW}>
          <div className="min-w-0 flex-1">
            {name
              ? <dt className="text-xs leading-5 text-muted-foreground">{displayFieldLabel(name)}</dt>
              : <Skeleton className="mb-1 h-3 w-20 rounded-full" />}
            <dd className="flex h-6 items-center">
              {mode === "loading"
                ? <Skeleton className="h-3.5 rounded-full" style={{ width: `${[62, 44, 54, 38, 58, 48][index % 6]}%` }} />
                : <span aria-hidden="true" className="h-2.5 w-24 rounded-full bg-muted" />}
            </dd>
          </div>
          {mode === "locked" && index === 0 ? <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        </div>
      ))}
      {mode === "locked" ? <span className="sr-only">Values are locked. Unlock to view.</span> : null}
      {mode === "unopenable" ? (
        <p className="flex items-center gap-1.5 px-3.5 py-2.5 text-xs leading-5 text-muted-foreground">
          <Lock className="size-3.5 shrink-0" aria-hidden="true" />
          Can’t be opened on this device.
        </p>
      ) : null}
    </dl>
  );
}

function SharedItem({ item, personName, status, onRetry }: {
  item: SharedWithYouItemView;
  personName: string;
  status: SharedWithYouCardStatus;
  onRetry?: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  const dates = sharedDatesLine(item.sharedAt, item.accessEndsAt);
  const rows = item.state === "ready" && item.data ? sharedValueRows(item.data, item.label, item.fields) : [];
  const headingId = `shared-item-${item.key.replace(/[^A-Za-z0-9_-]/g, "")}`;
  // A standard item can still hold an identifier field (an EIN under "Legal
  // entity"): Hide then masks those fields and leaves the rest readable.
  const canHide = item.state === "ready" && rows.length > 0
    && (item.sensitive || rows.some((row) => row.sensitive));

  return (
    <article aria-labelledby={headingId} data-testid="shared-with-you-item" data-item-state={item.state}
      data-sensitive={item.sensitive ? "true" : "false"} className="px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h4 id={headingId} className="text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground">{item.label}</h4>
          {dates ? <p className="text-xs leading-5 text-muted-foreground">{dates}</p> : null}
        </div>
        {canHide ? (
          <button type="button" aria-pressed={hidden} onClick={() => setHidden((current) => !current)}
            aria-label={hidden ? `Show ${item.label}` : `Hide ${item.label}`}
            className="-mr-2 -mt-1.5 inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {hidden ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
            <span>{hidden ? "Show" : "Hide"}</span>
          </button>
        ) : null}
      </div>

      {item.sensitive && item.state !== "ended" ? (
        <p data-testid="shared-with-you-sensitive"
          className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium leading-4 text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">Sensitive · not shared with One’s model</span>
        </p>
      ) : null}
      {item.purpose && item.state !== "ended" ? (
        <p className="mt-2 text-sm leading-6 text-foreground/80 [overflow-wrap:anywhere]">{item.purpose}</p>
      ) : null}

      <div className="mt-3">
        {item.state === "ended" ? (
          <AccessEndedNotice personName={personName} labels={[item.label]}
            reason={item.endedReason ?? "expired"} endedAt={item.endedAt ?? item.accessEndsAt} />
        ) : item.state === "unopenable" ? (
          <div className="overflow-hidden rounded-[var(--app-card-radius-compact)] bg-muted/40">
            <OutlineRows names={item.fieldOutline} mode="unopenable" />
          </div>
        ) : item.state === "unavailable" ? (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--app-card-radius-compact)] bg-muted/50 px-3.5 py-2.5">
            <p className="text-sm leading-6 text-muted-foreground">This couldn’t be opened right now.</p>
            {onRetry ? (
              <MorphyButton type="button" variant="muted" size="compact" onClick={onRetry}>Try again</MorphyButton>
            ) : null}
          </div>
        ) : (
          <div className="overflow-hidden rounded-[var(--app-card-radius-compact)] bg-muted/40">
            {item.state === "ready" && rows.length ? (
              <ValueRows rows={rows} hidden={hidden} itemLabel={item.label} itemSensitive={item.sensitive} />
            ) : item.state === "ready" ? (
              <p className={cn(ROW, "text-sm text-muted-foreground")}>Nothing readable was shared.</p>
            ) : (
              <OutlineRows names={item.fieldOutline} mode={status === "locked" || item.state === "locked" ? "locked" : "loading"} />
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export function SharedWithYouCardView({
  person,
  status,
  items,
  onUnlock,
  onRetry,
  variant = "chat",
  className,
}: SharedWithYouCardViewProps) {
  const line = statusLine(status);
  const name = person.displayName.trim() || "Someone";
  return (
    <section data-testid="shared-with-you-card" data-status={status} data-variant={variant}
      aria-label={`${name} shared with you`}
      className={cn(
        "overflow-hidden rounded-[calc(var(--app-card-radius-compact)+6px)] bg-[color:var(--app-card-surface-default-solid)]",
        variant === "chat"
          ? "shadow-[var(--app-card-shadow-standard)] ring-1 ring-border/50"
          : "shadow-[var(--app-card-shadow-standard)]",
        className,
      )}>
      <header className="flex items-center gap-3 border-b border-border/50 px-4 py-3 sm:px-5">
        <ConnectionPersonAvatar photoUrl={person.photoUrl ?? null} label={name} size="list" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold leading-6 tracking-[-0.015em] text-foreground">{name}</h3>
          <p className="text-xs leading-5 text-muted-foreground">Shared with you</p>
          {/* Its own line: a wrapped "Shared with you ·" left the dot orphaned at 393px. */}
          <p role="status" data-testid="shared-with-you-secure"
            className="flex items-center gap-1 text-xs leading-5 text-muted-foreground">
            {line.icon === "lock"
              ? <LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />
              : <ShieldCheck className="size-3.5 shrink-0 text-[color:var(--app-accent-deep)]" aria-hidden="true" />}
            <span className="min-w-0 truncate">{line.text}</span>
          </p>
        </div>
      </header>

      {status === "error" ? (
        <div role="alert" className="flex flex-col items-start gap-3 px-4 py-4 sm:px-5">
          <p className="text-sm leading-6 text-muted-foreground">
            What {firstName(name)} shared couldn’t be opened. Check your connection and try again.
          </p>
          {onRetry ? (
            <MorphyButton type="button" variant="muted" size="compact" onClick={onRetry}>
              <RefreshCw className="mr-1.5 size-4" aria-hidden="true" />
              Try again
            </MorphyButton>
          ) : null}
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {items.map((item) => (
            <SharedItem key={item.key} item={item} personName={name} status={status} onRetry={onRetry} />
          ))}
        </div>
      )}

      {status === "locked" ? (
        <footer className="border-t border-border/50 px-4 py-3.5 sm:px-5">
          <MorphyButton type="button" size="default" className="w-full sm:w-auto" onClick={onUnlock} disabled={!onUnlock}>
            <LockKeyhole className="mr-1.5 size-4" aria-hidden="true" />
            Unlock to view
          </MorphyButton>
        </footer>
      ) : null}
    </section>
  );
}
