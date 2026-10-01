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
    <div className="flex h-[var(--top-tabs-h)] w-full items-center">
    <SegmentedTabs
      value={value}
      onValueChange={(next) => onValueChange(next as GmailWorkspace)}
      options={[...OPTIONS]}
      mobileColumns={3}
      ariaLabel="Gmail workspace"
      variant="agent-top"
      className="bg-[color:var(--app-neutral-fill)] p-0.5 [&>button]:mx-0"
    />
    </div>
  );
}
