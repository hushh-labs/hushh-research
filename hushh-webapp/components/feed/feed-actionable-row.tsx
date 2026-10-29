"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { FeedSmsSentTime } from "@/components/feed/feed-sms-sent-time";
import { DirectMessageLink } from "@/components/direct-messages/direct-message-link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, X } from "@/components/icons";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { AgentUpdateProgress } from "@/components/agent/agent-update-progress";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { SEMANTIC_ROLE_CLASSES } from "@/lib/morphy-ux/tokens/semantic-roles";
import { cn } from "@/lib/utils";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { useArmedAction } from "@/lib/ui/use-armed-action";
import { ownerFacingConsentError } from "@/lib/consent/consent-owner-copy";
import { FeedRowMetadata, FeedRowTimestamp, FEED_INLINE_ROW_CLASSNAME } from "./feed-row-metadata";
import type {
  FeedActionButton,
  FeedActionable,
} from "@/lib/feed/use-feed-actionables";

/**
 * A resting danger action reads red before anyone taps it: the role's legible
 * red on its own light wash. Armed, it becomes the solid destructive button.
 */
const DANGER_REST_CLASS = cn(
  SEMANTIC_ROLE_CLASSES.danger.tile,
  SEMANTIC_ROLE_CLASSES.danger.glyph,
  "hover:bg-[color:var(--app-destructive-surface)]",
);

/** Quiet success wash with a legible label in either theme. */
const SUCCESS_CLASS = cn(
  SEMANTIC_ROLE_CLASSES.success.tile,
  SEMANTIC_ROLE_CLASSES.success.glyph,
  "hover:bg-[color:var(--app-success-surface)]",
);

/** Success is a decision's positive answer, so it takes the primary slot too. */
function isPrimaryTone(action: FeedActionButton): boolean {
  return action.tone === "primary" || action.tone === "success";
}

/**
 * A request that is only Accept (or Confirm) and Decline. Those two keep their
 * labels as accessible names but draw as a check and a cross, so the pair sits
 * beside the request instead of under it.
 */
function isDecisionPair(actions: FeedActionButton[]): boolean {
  if (actions.length !== 2) return false;
  const decline = actions.find((action) => /^decline$/i.test(action.label));
  const accept = actions.find((action) => /^(accept|confirm)$/i.test(action.label));
  return Boolean(decline && accept && decline !== accept && isPrimaryTone(accept));
}

function ActionButton({
  action,
  compact,
  dense,
  glyph,
  mobileLabel,
  runningActionKey,
  runAction,
}: {
  action: FeedActionButton;
  compact?: boolean;
  /** Draw the action as a check ("accept") or a cross ("decline"). */
  glyph?: "accept" | "decline";
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
      data-profile-role="action"
      title={glyph && !showConfirm ? action.label : undefined}
      variant={
        glyph
          ? "ghost"
          : showConfirm
            ? "destructive"
            : isPrimaryTone(action)
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
        glyph
          ? // The button is the 44px target; the glyph drawn inside is 28px.
            "!size-11 !min-w-11 shrink-0 !bg-transparent !p-0 hover:!bg-transparent"
          : "w-auto min-w-[5.5rem] max-w-full shrink-0 whitespace-nowrap px-4 sm:min-w-24",
        !glyph && compact && "h-11 min-h-11 min-w-0 rounded-full px-3 sm:min-w-0",
        dense && "max-sm:px-3",
        // Below 375px the row itself opens the same Details (see onSelect),
        // so the icon steps aside and the two decisions keep one line.
        action.phoneIcon && "min-w-11 px-0 max-[374px]:hidden sm:px-4",
        action.tone === "danger" && !showConfirm && DANGER_REST_CLASS,
        action.tone === "success" && SUCCESS_CLASS,
      )}
    >
      {glyph ? (
        <span
          className={cn(
            "inline-flex h-7 min-w-7 items-center justify-center rounded-full",
            showConfirm
              ? "bg-[color:var(--app-destructive)] px-3 text-white"
              : glyph === "accept"
                ? "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                : "bg-[color:var(--app-neutral-fill)] text-[color:var(--app-label)]",
          )}
        >
          {isRunning ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : showConfirm ? (
            confirmTap.label(action.label)
          ) : glyph === "accept" ? (
            <Check aria-hidden="true" weight="bold" className="size-4" />
          ) : (
            <X aria-hidden="true" weight="bold" className="size-4" />
          )}
        </span>
      ) : null}
      {!glyph && isRunning ? (
        <Icon icon={Loader2} size="xs" className="animate-spin" />
      ) : null}
      {glyph ? null : action.phoneIcon && !isRunning ? (
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
  // "Deny" is already short and pairs with "Allow"; only the longer refusals
  // fold to "Decline" on a phone.
  if (action.tone === "danger" && /\b(decline|reject)\b/.test(label)) {
    return "Decline";
  }
  if (isPrimaryTone(action) && /\b(accept|approve|confirm)\b/.test(label)) {
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

function ActionButtons({
  actions,
  compact = false,
  phoneActions,
}: {
  actions: FeedActionButton[];
  compact?: boolean;
  phoneActions?: FeedActionButton[];
}) {
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
    } catch (error) {
      toast.error(ownerFacingConsentError(error, "That didn't go through. Try again."));
    } finally {
      runningRef.current = false;
      setRunningActionKey(null);
    }
  };

  if (!actions.length) return null;
  const responsiveActions = (content: ReactNode) => phoneActions?.length ? (
    <>
      <div data-testid="feed-phone-actions" className="flex items-center gap-1.5 sm:hidden">
        {phoneActions.map(action => <ActionButton key={action.key} action={action} compact={compact}
          runningActionKey={runningActionKey} runAction={runAction} />)}
      </div>
      <div className="hidden sm:flex">{content}</div>
    </>
  ) : content;
  if (compact && isDecisionPair(actions)) {
    const decline = actions.find((action) => /^decline$/i.test(action.label))!;
    const accept = actions.find((action) => action !== decline)!;
    return responsiveActions(
      <div
        data-testid="feed-action-buttons"
        data-decision-glyphs=""
        className="flex flex-nowrap items-center justify-end"
      >
        {[
          [decline, "decline"],
          [accept, "accept"],
        ].map(([action, glyph]) => (
          <ActionButton
            key={(action as FeedActionButton).key}
            action={action as FeedActionButton}
            glyph={glyph as "accept" | "decline"}
            runningActionKey={runningActionKey}
            runAction={runAction}
          />
        ))}
      </div>
    );
  }
  const dense = actions.some((action) => Boolean(action.phoneIcon));
  const renderAction = (
    action: FeedActionButton,
    mobileLabel?: string,
  ) => (
    <ActionButton
      key={action.key}
      action={action}
      compact={compact}
      dense={dense}
      mobileLabel={mobileLabel}
      runningActionKey={runningActionKey}
      runAction={runAction}
    />
  );

  if (actions.length <= 2) {
    const primary = actions.find(isPrimaryTone) ?? actions[actions.length - 1]!;
    const secondary = actions.find((action) => action !== primary);
    return responsiveActions(
      <div
        data-testid="feed-action-buttons"
        className="flex w-auto min-w-0 shrink-0 flex-nowrap items-center justify-end gap-1.5"
      >
        {secondary
          ? renderAction(secondary, mobileDecisionLabel(secondary))
          : null}
        {renderAction(primary, mobileDecisionLabel(primary))}
      </div>
    );
  }

  // Keep decisions on one track. Scoped consent requests use their existing
  // full Review surface on phones, where the scope cannot fit beside decisions.
  return responsiveActions(
    <div
      data-testid="feed-action-buttons"
      className={cn(
        "flex w-auto min-w-0 shrink-0 flex-nowrap items-center justify-end gap-1.5",
        dense && "max-sm:flex-nowrap",
      )}
    >
      {actions.map((action) => renderAction(action))}
    </div>
  );
}

function FeedActionableIdentity({
  person,
  compact = false,
}: {
  person: NonNullable<FeedActionable["person"]>;
  compact?: boolean;
}) {
  return (
    <ConnectionPersonAvatar userId={person.userId} personRef={person.personRef}
      label={person.displayName}
      photoUrl={person.photoUrl}
      size={compact ? "compact" : "list"}
      className={cn(
        "bg-[color:var(--app-neutral-fill)] text-[13px] font-semibold text-[color:var(--app-secondary-label)]",
        compact && "size-[26px]",
      )}
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
  const indicator = item.spinning || isLive ? (
    <span aria-hidden="true" className={cn(
      "h-1.5 w-1.5 shrink-0 rounded-full animate-pulse motion-reduce:animate-none",
      isLive ? "bg-emerald-500" : "bg-accent",
    )} />
  ) : null;
  const router = useRouter();
  const hasActions = item.actions.length > 0;
  const leading = (
    <span className="grid w-[30px] place-items-center">
      {item.person ? (
        <FeedActionableIdentity person={item.person} compact />
      ) : item.id.startsWith("calendar:") ? (
        <span data-slot="feed-domain-icon" className="grid size-[22px] place-items-center text-[color:var(--app-label)]" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="size-[22px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
            <path stroke="var(--app-accent)" d="M3.5 9.8h17" />
            <path d="M8 2.8v3.6M16 2.8v3.6" />
            <circle cx="12" cy="14.9" r="1.7" fill="var(--app-accent)" stroke="none" />
          </svg>
        </span>
      ) : (
        <span data-slot="feed-domain-icon" className="grid size-[22px] place-items-center text-[color:var(--app-label)]" aria-hidden="true">
          <item.icon className="size-[22px]" />
        </span>
      )}
    </span>
  );

  const shared = {
    layout: "settings",
    density: "compact",
    leading,
    leadingInteractive: Boolean(item.person?.userId || item.person?.personRef),
    title: item.smsEmergency ? (
      <span className="block min-w-0 space-y-0.5 py-1">
        <span data-profile-role="name" className="block whitespace-normal [overflow-wrap:anywhere]">{item.title}</span>
        <span data-profile-role="description" data-slot="feed-event-description" className="flex items-center gap-1.5 whitespace-normal text-muted-foreground">{indicator}{item.description}</span>
        <FeedSmsSentTime timestamp={item.displayTimestamp} />
      </span>
    ) : item.updateProgress ? (
      <span className="block min-w-0 space-y-2 py-1">
        <FeedRowMetadata title={item.title} description={item.description} indicator={indicator} />
        <AgentUpdateProgress update={item.updateProgress} />
      </span>
    ) : <FeedRowMetadata title={item.title} description={item.description} indicator={indicator} />,
    ariaLabel: item.smsEmergency ? undefined : [item.title, item.description].filter(Boolean).join(". "),
    textOverflow: item.smsEmergency || item.updateProgress ? "wrap" : "truncate",
    trailing: <>
      {!item.smsEmergency ? <FeedRowTimestamp timestamp={item.displayTimestamp} /> : null}
      <ActionButtons actions={item.actions} phoneActions={item.phoneActions} compact />
    </>,
    trailingInteractive: hasActions,
    className: FEED_INLINE_ROW_CLASSNAME,
    stackTrailingOnMobile: false,
    testId: `feed-actionable-${item.id}`,
  } as const;

  // A row with inline actions must not also wrap those buttons in a link. For
  // scoped connections the explicit Review action owns navigation; for an
  // imperative row SettingsRow renders the primary action and trailing actions
  // as siblings. Both shapes avoid invalid button-in-link/button DOM.
  const NavigationLink = item.href?.startsWith("/one/messages?") ? DirectMessageLink : Link;
  const row =
    item.href && !hasActions && !shared.leadingInteractive ? (
      <SettingsRow asChild {...shared} chevron={item.chevron}>
        <NavigationLink
          href={item.href}
          prefetch={false}
          aria-label={item.smsEmergency ? undefined : [item.title, item.description].filter(Boolean).join(". ")}
        />
      </SettingsRow>
    ) : (
      <SettingsRow {...shared} chevron={item.chevron} onClick={item.onSelect ?? (item.href ? () => router.push(item.href!) : undefined)} />
    );

  return row;
}
