"use client";

import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";

export type GmailWorkspace = "overview" | "kyc" | "receipts";

const OPTIONS = [
  { value: "overview", label: "Overview" },
  { value: "kyc", label: "KYC" },
  { value: "receipts", label: "Receipts" },
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
