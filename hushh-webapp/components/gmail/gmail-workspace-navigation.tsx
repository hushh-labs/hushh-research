"use client";

import mailStyles from "./mail-workspace.module.css";
import type { ReactNode } from "react";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";

/**
 * Overview, Follow-ups and Receipts are the three Mail tabs. `kyc` is not one of
 * them: it names the KYC request-and-review screen, which is its own route and
 * is never offered here.
 */
export type GmailWorkspace = "overview" | "followups" | "receipts" | "kyc";
export type GmailWorkspaceTab = Exclude<GmailWorkspace, "kyc">;

const OPTIONS = [
  { value: "overview", label: "Overview" },
  { value: "followups", label: "Follow-ups" },
  { value: "receipts", label: "Receipts" },
] as const;
const TAB_SET_ID = "gmail-workspace";

/** The Mail tab a value selects; `kyc` is not a tab, so it falls back to Overview. */
export function gmailWorkspaceTab(workspace: GmailWorkspace): GmailWorkspaceTab {
  return workspace === "kyc" ? "overview" : workspace;
}

export function GmailWorkspaceNavigation({
  value,
  onValueChange,
}: {
  value: GmailWorkspace;
  onValueChange: (workspace: GmailWorkspace) => void;
}) {
  return (
    <div className="flex h-[var(--top-tabs-h)] w-full items-center">
      <SegmentedTabs
        value={gmailWorkspaceTab(value)}
        onValueChange={(next) => onValueChange(next as GmailWorkspace)}
        options={[...OPTIONS]}
        mobileColumns={3}
        ariaLabel="Gmail workspace"
        tabSetId={TAB_SET_ID}
        variant="agent-top"
        className={`${mailStyles.track} bg-[color:var(--app-neutral-fill)] p-0.5 [&>button]:mx-0`}
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
  panels: Record<GmailWorkspaceTab, ReactNode>;
}) {
  return (
    <SwipeViews
      options={OPTIONS}
      tabSetId={TAB_SET_ID}
      activeValue={gmailWorkspaceTab(value)}
      onSelectionChange={(next) => onValueChange(next as GmailWorkspace)}
      panelInset="none"
      viewportMinHeight="fill"
      heightMode="active"
    >
      {OPTIONS.map((option) => (
        <div key={option.value} className="space-y-4">
          {panels[option.value]}
        </div>
      ))}
    </SwipeViews>
  );
}
