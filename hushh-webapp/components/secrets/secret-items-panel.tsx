"use client";

/**
 * The secure Secrets card, shared by the chat (what was just kept) and the
 * Profile Secrets list. Presentational: the host decrypts a value only after
 * the vault is unlocked and passes it in; this card holds it in memory, shows
 * it until Hide, a 45 second window, or the app leaving the screen, and copies
 * it only after a second, confirming tap. Nothing here logs a value.
 *
 * Geometry is a contract, checked by e2e/secrets-card.layout.spec.ts: 16 px
 * symmetric insets, 12 px section gaps, 56 px rows, 44 px controls, flat
 * Morphy surfaces, bare duotone glyphs, ripple on every press.
 */

import { useEffect, useRef, useState } from "react";

import { Check, Copy, KycAgentIcon, LockedRowIcon, WalletAgentIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { SecretOffer } from "@/lib/pkm/secret-span-guard";
import { cn } from "@/lib/utils";

const AUTO_HIDE_SECONDS = 45;
const CONFIRM_WINDOW_MS = 4_000;
const COPIED_MS = 2_000;

// The shared flat app-card contract (app/globals.css), theme-aware in light and dark.
const SURFACE =
  "rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 text-foreground";
const INSET = "overflow-hidden rounded-xl border border-[color:var(--app-card-border-standard)]";

export type SecretPanelItem = {
  id: string;
  label: string;
  /** "API key or password", "Card number", ... never the value. */
  kindLabel: string;
  offer: SecretOffer | null;
  filedLabel: string | null;
};

export type SecretItemsPanelProps = {
  testId: string;
  title: string;
  description: string;
  items: readonly SecretPanelItem[];
  /** Values the host decrypted after unlock, by item id. Memory only. */
  revealed: Readonly<Record<string, string>>;
  locked: boolean;
  busyId?: string | null;
  onReveal: (id: string) => void;
  onHide: (id: string) => void;
  onUnlock: () => void;
  onOffer?: (item: SecretPanelItem) => void;
  onRemove?: (item: SecretPanelItem) => void;
};

function RevealedValue({
  label,
  value,
  onHide,
  onRemove,
}: {
  label: string;
  value: string;
  onHide: () => void;
  onRemove?: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_HIDE_SECONDS);
  const [copyState, setCopyState] = useState<"idle" | "confirm" | "copied">("idle");
  const [announcement, setAnnouncement] = useState("");
  // The host's handler may change identity every render; the timers must not restart.
  const onHideRef = useRef(onHide);
  useEffect(() => {
    onHideRef.current = onHide;
  }, [onHide]);

  useEffect(() => {
    const timer = window.setInterval(() => setSecondsLeft((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (secondsLeft === 0) onHideRef.current();
  }, [secondsLeft]);
  // Leaving the app hides the value, so it is not in the app switcher's snapshot.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHideRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), copyState === "confirm" ? CONFIRM_WINDOW_MS : COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const copy = async () => {
    if (copyState !== "confirm") {
      setCopyState("confirm");
      setAnnouncement(`Tap again to copy ${label}.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
      setAnnouncement(`${label} copied.`);
    } catch {
      setCopyState("idle");
      setAnnouncement("Copying is not available here.");
    }
  };

  return (
    <div className="flex flex-col gap-2 px-4 pb-3" data-testid="secret-revealed">
      <p
        className="break-all rounded-lg bg-[color:var(--app-card-surface-data)] px-3 py-2 font-mono text-sm leading-5 dark:bg-[color:var(--app-neutral-fill)]"
        data-testid="secret-revealed-value"
      >
        {value}
      </p>
      <div className="flex min-h-11 items-center justify-between gap-2">
        <span className="text-xs leading-4 text-foreground/70 tabular-nums" data-testid="secret-countdown">
          Hides in {secondsLeft}s
        </span>
        <span className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="compact"
            onClick={() => void copy()}
            data-testid="secret-copy"
            data-copy-state={copyState}
          >
            {copyState === "copied" ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
            {copyState === "confirm" ? "Tap to confirm" : copyState === "copied" ? "Copied" : "Copy"}
          </Button>
          <Button type="button" variant="secondary" size="compact" onClick={onHide} data-testid="secret-hide">
            Hide
          </Button>
        </span>
      </div>
      {onRemove ? (
        // Removing is a deliberate act on a secret the owner is looking at,
        // so it lives here rather than beside every label in the list.
        <Button
          type="button"
          variant="ghost"
          size="compact"
          // Text optically aligned with the label and value above it.
          className="-ml-4 self-start text-[color:var(--app-destructive)]"
          onClick={onRemove}
          data-testid="secret-remove"
        >
          Remove from Secrets
        </Button>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

function OfferIcon({ offer }: { offer: SecretOffer }) {
  return offer.fileTo === "wallet" ? (
    <WalletAgentIcon size={20} aria-hidden="true" className="shrink-0" />
  ) : (
    <KycAgentIcon size={20} aria-hidden="true" className="shrink-0" />
  );
}

export function SecretItemsPanel({
  testId,
  title,
  description,
  items,
  revealed,
  locked,
  busyId = null,
  onReveal,
  onHide,
  onUnlock,
  onOffer,
  onRemove,
}: SecretItemsPanelProps) {
  const offers = onOffer ? items.filter((item) => item.offer && !item.filedLabel) : [];
  return (
    <section aria-label={title} className={cn(SURFACE, "motion-step-enter flex flex-col gap-3")} data-testid={testId}>
      <header className="flex h-6 items-center gap-2">
        <LockedRowIcon size={20} aria-hidden="true" className="shrink-0" />
        <p className="text-sm font-semibold leading-6" role="status">
          {title}
        </p>
      </header>
      <p className="text-xs leading-4 text-foreground/70">{description}</p>

      <ul className={cn(INSET, "m-0 list-none p-0")} data-testid="secret-rows">
        {items.map((item, index) => {
          const value = revealed[item.id];
          return (
            <li key={item.id} className="relative" data-testid="secret-row">
              {index > 0 ? (
                <span aria-hidden="true" className="pointer-events-none absolute left-4 right-0 top-0 h-px bg-[color:var(--app-separator)]" />
              ) : null}
              <div className="flex min-h-14 items-center gap-3 px-4 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium leading-5" data-testid="secret-label">
                    {item.label}
                  </span>
                  <span className="truncate text-xs leading-4 text-foreground/70">{item.filedLabel ?? item.kindLabel}</span>
                </span>
                {locked ? (
                  <Button type="button" variant="secondary" size="compact" onClick={onUnlock} data-testid="secret-unlock">
                    Unlock
                  </Button>
                ) : value ? null : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    onClick={() => onReveal(item.id)}
                    isLoading={busyId === item.id}
                    disabled={busyId === item.id}
                    data-testid="secret-reveal"
                  >
                    Reveal
                  </Button>
                )}
              </div>
              {value && !locked ? (
                <RevealedValue
                  label={item.label}
                  value={value}
                  onHide={() => onHide(item.id)}
                  onRemove={onRemove ? () => onRemove(item) : undefined}
                />
              ) : null}
            </li>
          );
        })}
      </ul>

      {offers.length ? (
        <div className="flex flex-col gap-2" data-testid="secret-offers">
          {offers.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="secondary"
              size="compact"
              // The label wraps rather than truncates: "Add passport to
              // Identity documents" must read whole at 320 px.
              className="h-auto w-full justify-start gap-3 whitespace-normal py-3 text-left"
              onClick={() => onOffer?.(item)}
              data-testid="secret-offer"
            >
              <OfferIcon offer={item.offer!} />
              <span className="min-w-0">{item.offer!.actionLabel}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export const SECRET_KIND_LABELS: Readonly<Record<string, string>> = {
  credential: "Key, token or password",
  card_number: "Card number",
  card_security_code: "Card code",
  government_id: "ID number",
  bank_account: "Bank account",
};
