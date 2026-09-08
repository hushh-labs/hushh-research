"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { FeedRowMetadata } from "./feed-row-metadata";
import type {
  FeedActionButton,
  FeedActionable,
} from "@/lib/feed/use-feed-actionables";

function ActionButton({
  action,
  runningActionKey,
  runAction,
}: {
  action: FeedActionButton;
  runningActionKey: string | null;
  runAction: (action: FeedActionButton) => Promise<void>;
}) {
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

  const runNow = () => {
    setArmed(false);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    void runAction(action);
  };

  const showConfirm = action.confirm && armed;
  const actionsLocked = runningActionKey !== null;
  const isRunning = runningActionKey === action.key;

  useEffect(() => {
    if (!actionsLocked || isRunning) return;
    setArmed(false);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
  }, [actionsLocked, isRunning]);

  return (
    <button
      type="button"
      disabled={action.disabled || actionsLocked}
      aria-label={
        showConfirm
          ? `Confirm ${action.label}`
          : action.confirm
            ? `${action.label} (tap again to confirm)`
            : undefined
      }
      onClick={(event) => {
        // The row itself may be a link/button; never let an action bubble into it.
        event.stopPropagation();
        event.preventDefault();
        if (actionsLocked) return;
        if (action.confirm && !armed) {
          setArmed(true);
          if (disarmTimer.current) clearTimeout(disarmTimer.current);
          disarmTimer.current = setTimeout(() => setArmed(false), 3500);
          return;
        }
        runNow();
      }}
      className={cn(
        "inline-flex min-h-11 max-w-full items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        action.tone === "primary" &&
          "bg-accent text-accent-foreground hover:bg-accent/90",
        action.tone === "ghost" &&
          "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]",
        action.tone === "danger" &&
          "bg-foreground/[0.06] text-destructive hover:bg-destructive/10",
        showConfirm &&
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      )}
    >
      {isRunning ? (
        <Icon icon={Loader2} size="xs" className="animate-spin" />
      ) : null}
      {showConfirm ? "Sure?" : action.label}
    </button>
  );
}

function ActionButtons({ actions }: { actions: FeedActionButton[] }) {
  const runningRef = useRef(false);
  const [runningActionKey, setRunningActionKey] = useState<string | null>(null);

  const runAction = async (action: FeedActionButton) => {
    // State does not update until React renders again. The ref closes the
    // same-tick window in which two sibling buttons could both start work.
    if (runningRef.current) return;
    runningRef.current = true;
    setRunningActionKey(action.key);
    try {
      await action.run();
    } catch {
      toast.error("That didn't go through. Try again.");
    } finally {
      runningRef.current = false;
      setRunningActionKey(null);
    }
  };

  if (!actions.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      {actions.map((action) => (
        <ActionButton
          key={action.key}
          action={action}
          runningActionKey={runningActionKey}
          runAction={runAction}
        />
      ))}
    </span>
  );
}

function FeedActionableIdentity({
  person,
}: {
  person: NonNullable<FeedActionable["person"]>;
}) {
  return (
    <ConnectionPersonAvatar
      label={person.displayName}
      photoUrl={person.photoUrl}
      size="list"
      testId="feed-actionable-avatar"
    />
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
        <span className="whitespace-normal [overflow-wrap:anywhere]">
          {item.description}
        </span>
      </span>
    ) : (
      <span className="min-w-0">{item.description}</span>
    );

  const description = (
    <FeedRowMetadata
      description={descriptionBody}
      timestamp={item.displayTimestamp}
    />
  );

  const hasActions = item.actions.length > 0;
  const leading = item.person ? (
    <FeedActionableIdentity person={item.person} />
  ) : undefined;

  const shared = {
    layout: "person",
    icon: leading ? undefined : item.icon,
    iconTone: leading ? undefined : item.iconTone,
    leading,
    title: item.title,
    description,
    trailing: <ActionButtons actions={item.actions} />,
    trailingInteractive: hasActions,
    // Actions are sized to their content and carry three separate `shrink-0`s,
    // so on a phone they take the row's width first and leave the text column
    // at literally 0px: "Deny" + "Approve 4 hours more" is 238.5px of a 358px
    // row. The title then wrapped one character per line — a 307px-tall row of
    // single letters at 320px — and the description had nowhere to go.
    // Stacking gives the text the full width and the buttons their own line.
    // Only rows that HAVE actions stack; a chevron row is 16px and fine inline.
    stackTrailingOnMobile: hasActions,
    testId: `feed-actionable-${item.id}`,
  } as const;

  // A row with inline actions must not also wrap those buttons in a link. For
  // scoped connections the explicit Review action owns navigation; for an
  // imperative row SettingsRow renders the primary action and trailing actions
  // as siblings. Both shapes avoid invalid button-in-link/button DOM.
  const row =
    item.href && !hasActions ? (
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

  return row;
}
