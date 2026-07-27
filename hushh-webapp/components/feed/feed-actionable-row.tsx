"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import type {
  FeedActionButton,
  FeedActionable,
} from "@/lib/feed/use-feed-actionables";

function ActionButton({ action }: { action: FeedActionButton }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={action.disabled || busy}
      onClick={async (event) => {
        // The row itself may be a link/button; never let an action bubble into it.
        event.stopPropagation();
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          await action.run();
        } catch {
          toast.error("That didn't go through. Try again.");
        } finally {
          setBusy(false);
        }
      }}
      className={cn(
        "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        action.tone === "primary" &&
          "bg-accent text-accent-foreground hover:bg-accent/90",
        action.tone === "ghost" &&
          "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]",
        action.tone === "danger" &&
          "bg-foreground/[0.06] text-destructive hover:bg-destructive/10",
      )}
    >
      {busy ? <Icon icon={Loader2} size="xs" className="animate-spin" /> : null}
      {action.label}
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
  const description = item.spinning ? (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
      {item.description}
    </span>
  ) : (
    item.description
  );

  const shared = {
    icon: item.icon,
    iconTone: item.iconTone,
    title: item.title,
    description,
    trailing: <ActionButtons actions={item.actions} />,
  } as const;

  if (item.href) {
    return (
      <SettingsRow asChild {...shared} chevron={item.chevron}>
        <Link href={item.href} prefetch={false} aria-label={item.title} />
      </SettingsRow>
    );
  }

  return (
    <SettingsRow {...shared} chevron={item.chevron} onClick={item.onSelect} />
  );
}
