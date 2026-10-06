"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/components/icons";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { useArmedAction } from "@/lib/ui/use-armed-action";
import { FeedRowMetadata } from "./feed-row-metadata";
import type {
  FeedActionButton,
  FeedActionable,
} from "@/lib/feed/use-feed-actionables";

function ActionButton({
  action,
  dense,
  mobileLabel,
  runningActionKey,
  runAction,
}: {
  action: FeedActionButton;
  /** Tighter phone padding, for a row that carries a third quiet action. */
  dense?: boolean;
  mobileLabel?: string;
  runningActionKey: string | null;
  runAction: (action: FeedActionButton) => Promise<void>;
}) {
  // Irreversible actions (Deny / Decline / Cancel) require a confirming second
  // tap: the first tap arms the button ("Sure?") and auto-disarms after a few
  // seconds, so a stray tap can't reject a request or abort a running analysis.
  const confirmTap = useArmedAction();
  const { armed, disarm } = confirmTap;

  const runNow = () => {
    void runAction(action);
  };

  const showConfirm = action.confirm && armed;
  const actionsLocked = runningActionKey !== null;
  const isRunning = runningActionKey === action.key;

  useEffect(() => {
    if (!actionsLocked || isRunning) return;
    disarm();
  }, [actionsLocked, disarm, isRunning]);

  return (
    <Button
      type="button"
      size="compact"
      variant={
        showConfirm
          ? "destructive"
          : action.tone === "primary"
            ? "default"
            : "secondary"
      }
      disabled={action.disabled || actionsLocked}
      aria-label={
        action.confirm ? confirmTap.ariaLabel(action.label) : action.label
      }
      onClick={(event) => {
        // The row itself may be a link/button; never let an action bubble into it.
        event.stopPropagation();
        event.preventDefault();
        if (actionsLocked) return;
        if (action.confirm) {
          confirmTap.activate(runNow);
          return;
        }
        runNow();
      }}
      className={cn(
        "w-auto min-w-[5.5rem] max-w-full shrink-0 whitespace-nowrap px-4 sm:min-w-24",
        dense && "max-sm:px-3",
        // Below 375px the row itself opens the same Details (see onSelect),
        // so the icon steps aside and the two decisions keep one line.
        action.phoneIcon && "min-w-11 px-0 max-[374px]:hidden sm:px-4",
        action.tone === "danger" &&
          !showConfirm &&
          "text-destructive hover:bg-destructive/10",
      )}
    >
      {isRunning ? (
        <Icon icon={Loader2} size="xs" className="animate-spin" />
      ) : null}
      {action.phoneIcon && !isRunning ? (
        <>
          <Icon
            icon={action.phoneIcon}
            size="sm"
            aria-hidden="true"
            className="sm:hidden"
          />
          <span aria-hidden="true" className="hidden sm:inline">
            {action.label}
          </span>
        </>
      ) : mobileLabel && !showConfirm ? (
        <>
          <span aria-hidden="true" className="sm:hidden">
            {mobileLabel}
          </span>
          <span aria-hidden="true" className="hidden sm:inline">
            {action.label}
          </span>
        </>
      ) : action.confirm ? (
        confirmTap.label(action.label)
      ) : (
        action.label
      )}
    </Button>
  );
}

function mobileDecisionLabel(action: FeedActionButton): string | undefined {
  const label = action.label.toLowerCase();
  if (
    action.tone === "danger" &&
    /\b(deny|decline|reject)\b/.test(label)
  ) {
    return "Decline";
  }
  if (
    action.tone === "primary" &&
    /\b(accept|approve|confirm)\b/.test(label)
  ) {
    if (/\buntil you stop\b/.test(label)) {
      return "Accept · Until off";
    }
    const duration = label.match(
      /\b(\d+)\s*(minute|minutes|min|hour|hours|hr|hrs|day|days)\b/,
    );
    if (duration) {
      const unit =
        duration[2]!.startsWith("hour") || duration[2]!.startsWith("hr")
          ? "h"
          : duration[2]!.startsWith("day")
            ? "d"
            : "m";
      return `Accept · ${duration[1]}${unit}`;
    }
    return "Accept";
  }
  return undefined;
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
  const dense = actions.some((action) => Boolean(action.phoneIcon));
  const renderAction = (
    action: FeedActionButton,
    mobileLabel?: string,
  ) => (
    <ActionButton
      key={action.key}
      action={action}
      dense={dense}
      mobileLabel={mobileLabel}
      runningActionKey={runningActionKey}
      runAction={runAction}
    />
  );

  if (actions.length <= 2) {
    const primary =
      actions.find((action) => action.tone === "primary") ??
      actions[actions.length - 1]!;
    const secondary = actions.find((action) => action !== primary);
    return (
      <div
        data-testid="feed-action-buttons"
        className="flex w-full min-w-0 flex-nowrap items-center justify-end gap-2 sm:w-auto"
      >
        {secondary
          ? renderAction(secondary, mobileDecisionLabel(secondary))
          : null}
        {renderAction(primary, mobileDecisionLabel(primary))}
      </div>
    );
  }

  // A dense row (the owner's consent request) is sized so its phone actions
  // fit one line with under 2px to spare at 320px, and Linux text metrics are
  // about 1.5px wider than a Mac's. Wrapping there dropped Allow onto its own
  // line and grew the row 52px. On a phone the line never wraps; any excess
  // spills into the empty stack indent on the left, as the pair branch does.
  return (
    <div
      data-testid="feed-action-buttons"
      className={cn(
        "flex w-full min-w-0 flex-wrap items-center justify-end gap-2 sm:w-auto",
        dense && "max-sm:flex-nowrap",
      )}
    >
      {actions.map((action) => renderAction(action))}
    </div>
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
      className="bg-[color:var(--app-neutral-fill)] text-[13px] font-semibold text-[color:var(--app-secondary-label)]"
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
  const isMeetJoin = item.actions.length === 1 && item.actions[0]?.key === "join-meet";
  const leading = item.person ? (
    <FeedActionableIdentity person={item.person} />
  ) : undefined;

  const shared = {
    layout: "person",
    icon: leading ? undefined : item.icon,
    iconTone: leading ? undefined : item.iconTone,
    leading,
    title: item.title,
    textOverflow: isMeetJoin ? "truncate" : "wrap",
    description,
    trailing: <ActionButtons actions={item.actions} />,
    trailingInteractive: hasActions,
    // Actions are sized to their content and carry three separate `shrink-0`s,
    // so on a phone they take the row's width first and leave the text column
    // at literally 0px: "Deny" + "Approve 4 hours more" is 238.5px of a 358px
    // row. The title then wrapped one character per line — a 307px-tall row of
    // single letters at 320px — and the description had nowhere to go.
    // Stacking gives the text the full width and the buttons their own line.
    // A single meeting CTA fits beside truncated event details; wider action
    // groups retain their own line. Chevron-only rows also stay inline.
    stackTrailingOnMobile: hasActions && !isMeetJoin,
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
