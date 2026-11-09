"use client";

import { useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { FinanceSharingManager } from "./finance-sharing-manager";
import type { FinanceSource } from "@/lib/finance-sharing/contract";

/** Access management remains reachable even after the source portfolio is removed. */
export function FinanceSharingHistoryAction({ label = "Sharing", hasPortfolio = true, preferredSource }: { label?: string; hasPortfolio?: boolean; preferredSource?: FinanceSource }) {
  const [open, setOpen] = useState(false);
  return <><ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" onClick={() => setOpen(true)}>{label}</ShellActionSurface><FinanceSharingManager hasPortfolio={hasPortfolio} preferredSource={preferredSource} open={open} onOpenChange={setOpen} /></>;
}
