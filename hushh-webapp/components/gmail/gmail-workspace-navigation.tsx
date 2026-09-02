"use client";

import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";

export type GmailWorkspace = "overview" | "receipts" | "verification";

const OPTIONS = [
  { value: "overview", label: "Overview" },
  { value: "receipts", label: "Receipts" },
  { value: "verification", label: "Verification" },
] as const;

export function GmailWorkspaceNavigation({
  value,
  onValueChange,
}: {
  value: GmailWorkspace;
  onValueChange: (workspace: GmailWorkspace) => void;
}) {
  return (
    <SegmentedTabs
      value={value}
      onValueChange={(next) => onValueChange(next as GmailWorkspace)}
      options={[...OPTIONS]}
      mobileColumns={3}
      ariaLabel="Gmail workspace"
    />
  );
}
