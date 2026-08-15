"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { formatFeedTimestamp } from "@/lib/feed/feed-timestamp";
import type {
  FeedActionButton,
  FeedActionable,
} from "@/lib/feed/use-feed-actionables";

function ActionButton({ action }: { action: FeedActionButton }) {
  const [busy, setBusy] = useState(false);
  // Irreversible actions (Deny / Decline / Cancel) require a confirming second
  // tap: the first tap arms the button ("Sure?") and auto-disarms after a few
  // seconds, so a stray tap can't reject a request or abort a running analysis.
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, []);

  const runNow = async () => {
    setArmed(false);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setBusy(true);
    try {
      await action.run();
    } catch {
      toast.error("That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const showConfirm = action.confirm && armed;

  return (
    <button
      type="button"
      disabled={action.disabled || busy}
      aria-label={
        action.confirm && !armed ? `${action.label} (tap again to confirm)` : undefined
      }
      onClick={(event) => {
        // The row itself may be a link/button; never let an action bubble into it.
        event.stopPropagation();
        event.preventDefault();
        if (busy) return;
        if (action.confirm && !armed) {
          setArmed(true);
          if (disarmTimer.current) clearTimeout(disarmTimer.current);
          disarmTimer.current = setTimeout(() => setArmed(false), 3500);
          return;
        }
        void runNow();
      }}
      className={cn(
        "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        action.tone === "primary" &&
          "bg-accent text-accent-foreground hover:bg-accent/90",
        action.tone === "ghost" &&
          "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]",
        action.tone === "danger" &&
          "bg-foreground/[0.06] text-destructive hover:bg-destructive/10",
        showConfirm && "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      )}
    >
      {busy ? <Icon icon={Loader2} size="xs" className="animate-spin" /> : null}
      {showConfirm ? "Sure?" : action.label}
    </button>
  );
}

function ActionButtons({ actions }: { actions: FeedActionButton[] }) {
  if (!actions.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-2">
      {actions.map((action) => (
        <ActionButton key={action.key} action={action} />
      ))}
    </span>
  );
}

/**
 * A live "Needs you" row: a pending request or in-flight task with its inline
 * actions. Reuses SettingsRow — a consent row is a whole-row Review link; a
 * running debate row taps to resume and keeps a Cancel action; request rows
 * (location / connection) carry their Approve/Deny buttons in the trailing
 * slot. SettingsRow's split-primary handling keeps the row tap and the
 * trailing buttons from nesting.
 */
export function FeedActionableRow({ item }: { item: FeedActionable }) {
  const timeLabel =
    item.displayTimestamp != null
      ? formatFeedTimestamp(item.displayTimestamp)
      : null;
  const isLive = item.emphasis === "emergency";

  const descriptionBody =
    item.spinning || isLive ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full animate-pulse motion-reduce:animate-none",
            isLive ? "bg-emerald-500" : "bg-accent",
          )}
        />
        <span className="truncate">{item.description}</span>
      </span>
    ) : (
      <span className="min-w-0 truncate">{item.description}</span>
    );

  const description = timeLabel ? (
    <span className="flex items-center gap-2">
      <span className="min-w-0 flex-1">{descriptionBody}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {timeLabel}
      </span>
    </span>
  ) : (
    descriptionBody
  );

  const shared = {
    icon: item.icon,
    iconTone: item.iconTone,
    title: item.title,
    description,
    trailing: <ActionButtons actions={item.actions} />,
  } as const;

  const row = item.href ? (
    <SettingsRow asChild {...shared} chevron={item.chevron}>
      <Link
        href={item.href}
        prefetch={false}
        aria-label={`${item.title}. ${item.description}`}
      />
    </SettingsRow>
  ) : (
    <SettingsRow {...shared} chevron={item.chevron} onClick={item.onSelect} />
  );

  // Emergency SMS alerts get a prominent red frame so a safety alert stands out
  // from routine "Needs you" rows.
  if (item.emphasis === "emergency") {
    return (
      <div
        role="alert"
        data-testid="feed-sms-emergency"
        className="overflow-hidden rounded-2xl border border-destructive/45 bg-destructive/[0.06] ring-1 ring-inset ring-destructive/20"
      >
        {row}
      </div>
    );
  }

  return row;
}
