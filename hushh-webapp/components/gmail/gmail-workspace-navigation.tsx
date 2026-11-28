"use client";

import mailStyles from "./mail-workspace.module.css";
import type { ReactNode } from "react";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";

export const MAIL_WORKSPACE_TABS = [
  { value: "overview", label: "Overview" },
  { value: "views", label: "Views" },
] as const;

export const MAIL_PINNED_VIEWS = [
  { value: "followups", label: "Follow-ups" },
  { value: "receipts", label: "Receipts" },
  { value: "kyc", label: "Info Requests" },
] as const;

type MailWorkspaceTab = (typeof MAIL_WORKSPACE_TABS)[number]["value"];
export type MailPinnedView = (typeof MAIL_PINNED_VIEWS)[number]["value"];
export type GmailWorkspace = MailWorkspaceTab | MailPinnedView;

export function mailTabForWorkspace(workspace: GmailWorkspace): MailWorkspaceTab {
  return workspace === "overview" ? "overview" : "views";
}
const TAB_SET_ID = "gmail-workspace";

export function GmailWorkspaceNavigation({
  value,
  onValueChange,
}: {
  value: GmailWorkspace;
  onValueChange: (workspace: GmailWorkspace) => void;
}) {
  return (
    <div className="flex h-[var(--top-tabs-h)] w-full items-center justify-center">
      <SegmentedTabs
        value={mailTabForWorkspace(value)}
        onValueChange={(next) => onValueChange(next as MailWorkspaceTab)}
        options={[...MAIL_WORKSPACE_TABS]}
        mobileColumns={2}
        ariaLabel="Gmail workspace"
        tabSetId={TAB_SET_ID}
        variant="agent-top"
        className={`${mailStyles.track} max-w-[calc(var(--app-shell-agent)-2*var(--page-inline-gutter-standard))] bg-[color:var(--app-neutral-fill)] p-0.5 [&>button]:mx-0`}
      />
    </div>
  );
}

/** The existing workspace owner handles taps and drags through one selection.
 * Retained inactive panes are inert and cannot publish voice actions. */
export function GmailWorkspacePanels({
  value,
  onValueChange,
  panels,
}: {
  value: GmailWorkspace;
  onValueChange: (workspace: GmailWorkspace) => void;
  panels: Record<MailWorkspaceTab, ReactNode>;
}) {
  return (
    <SwipeViews
      options={MAIL_WORKSPACE_TABS}
      tabSetId={TAB_SET_ID}
      activeValue={mailTabForWorkspace(value)}
      onSelectionChange={(next) => onValueChange(next as MailWorkspaceTab)}
      panelInset="none"
      viewportMinHeight="fill"
      heightMode="active"
    >
      {MAIL_WORKSPACE_TABS.map((option) => (
        <div key={option.value} className="space-y-4">
          {panels[option.value]}
        </div>
      ))}
    </SwipeViews>
  );
}
