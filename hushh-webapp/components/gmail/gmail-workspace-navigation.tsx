"use client";

import type { ReactNode } from "react";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";

export type GmailWorkspace = "overview" | "kyc" | "receipts";

const OPTIONS = [
  { value: "overview", label: "Overview" },
  { value: "kyc", label: "KYC" },
  { value: "receipts", label: "Receipts" },
] as const;
const TAB_SET_ID = "gmail-workspace";

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
        value={value}
        onValueChange={(next) => onValueChange(next as GmailWorkspace)}
        options={[...OPTIONS]}
        mobileColumns={3}
        ariaLabel="Gmail workspace"
        tabSetId={TAB_SET_ID}
        variant="agent-top"
        className="bg-[color:var(--app-neutral-fill)] p-0.5 [&>button]:mx-0"
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
  panels: Record<GmailWorkspace, ReactNode>;
}) {
  return (
    <SwipeViews
      options={OPTIONS}
      tabSetId={TAB_SET_ID}
      activeValue={value}
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
