"use client";

import { useCallback, useState } from "react";
import { Activity, Bell, Loader2 } from "lucide-react";

import { DebateTaskCenter, type TaskActivityState } from "@/components/app-ui/debate-task-center";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import {
  TOP_SHELL_DROPDOWN_BODY_CLASSNAME,
  TOP_SHELL_DROPDOWN_HEADER_CLASSNAME,
  TopShellDropdownContent,
} from "@/components/app-ui/top-shell-dropdown";
import {
  ConsentInboxDropdown,
  type ConsentInboxActivityState,
} from "@/components/consent/consent-inbox-dropdown";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

const EMPTY_CONSENT_ACTIVITY: ConsentInboxActivityState = {
  pendingCount: null,
  loading: false,
};

const EMPTY_TASK_ACTIVITY: TaskActivityState = {
  activeCount: 0,
  badgeCount: 0,
  hasActivity: false,
};

function sameConsentActivity(
  current: ConsentInboxActivityState,
  next: ConsentInboxActivityState,
) {
  return (
    current.pendingCount === next.pendingCount && current.loading === next.loading
  );
}

function sameTaskActivity(current: TaskActivityState, next: TaskActivityState) {
  return (
    current.activeCount === next.activeCount &&
    current.badgeCount === next.badgeCount &&
    current.hasActivity === next.hasActivity
  );
}

/**
 * A single shell entry point for the two independent activity domains.
 *
 * Consent and background task ownership intentionally stay inside their domain
 * adapters. This component only composes their already-authorized previews
 * into one quiet activity surface.
 */
export function ActivityInbox() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [consentActivity, setConsentActivity] = useState(EMPTY_CONSENT_ACTIVITY);
  const [taskActivity, setTaskActivity] = useState(EMPTY_TASK_ACTIVITY);

  const handleConsentActivity = useCallback((next: ConsentInboxActivityState) => {
    setConsentActivity((current) =>
      sameConsentActivity(current, next) ? current : next,
    );
  }, []);
  const handleTaskActivity = useCallback((next: TaskActivityState) => {
    setTaskActivity((current) => (sameTaskActivity(current, next) ? current : next));
  }, []);

  const pendingConsentCount = Math.max(0, consentActivity.pendingCount ?? 0);
  const badgeCount = pendingConsentCount + taskActivity.badgeCount;
  const hasPendingConsent = pendingConsentCount > 0;
  const ariaLabel = hasPendingConsent
    ? `Open activity. ${pendingConsentCount} consent request${pendingConsentCount === 1 ? "" : "s"} need review.`
    : taskActivity.activeCount > 0
      ? `Open activity. ${taskActivity.activeCount} task${taskActivity.activeCount === 1 ? "" : "s"} in progress.`
      : "Open activity";

  const trigger = (
    <ShellActionSurface
      variant="icon"
      aria-label={ariaLabel}
      // The shared shell surface reserves this trailing gutter for its badge.
      // Keeping the count entirely beyond the 36px icon well prevents its
      // circular outline from cutting into the activity or Profile action.
      wrapperClassName={badgeCount > 0 ? "pr-5" : undefined}
      badge={
        badgeCount > 0 ? (
          <span
            className={
              hasPendingConsent
                ? "inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-foreground shadow-[var(--morphy-cta-shadow)] ring-2 ring-background"
                : "inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-semibold leading-none text-background ring-2 ring-background"
            }
          >
            {badgeCount}
          </span>
        ) : null
      }
    >
      <span className="relative inline-flex items-center justify-center">
        <Activity className="h-5 w-5 sm:hidden" aria-hidden="true" />
        {taskActivity.activeCount > 0 ? (
          <Loader2 className="hidden h-5 w-5 animate-spin text-accent-strong sm:block" aria-hidden="true" />
        ) : (
          <Bell className="hidden h-5 w-5 sm:block" aria-hidden="true" />
        )}
      </span>
    </ShellActionSurface>
  );

  const sections = (
    <>
      <ConsentInboxDropdown
        presentation="section"
        onActivityChange={handleConsentActivity}
        onRequestClose={() => setOpen(false)}
      />
      <DebateTaskCenter
        presentation="section"
        onActivityChange={handleTaskActivity}
      />
    </>
  );

  if (isMobile) {
    return (
      <Sheet modal open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          overlayClassName="activity-inbox-sheet-overlay"
          className="max-h-[82dvh] gap-0 overflow-y-auto overscroll-contain rounded-t-[var(--app-card-radius-feature)] border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-0"
        >
          <SheetTitle className="sr-only">Activity</SheetTitle>
          <div className="border-b border-border/50 px-4 pb-3">
            <p className="text-sm font-semibold text-foreground">Activity</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Requests to review and work in progress
            </p>
          </div>
          <div className="px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
            {sections}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        {trigger}
      </DropdownMenuTrigger>

      <TopShellDropdownContent align="end">
        <div className={TOP_SHELL_DROPDOWN_HEADER_CLASSNAME}>
          <p className="text-sm font-semibold text-foreground">Activity</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Requests to review and work in progress
          </p>
        </div>

        <div className={TOP_SHELL_DROPDOWN_BODY_CLASSNAME}>
          {sections}
        </div>
      </TopShellDropdownContent>
    </DropdownMenu>
  );
}
