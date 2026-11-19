"use client";

import { useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { FinanceSharingManager } from "./finance-sharing-manager";
import type { FinanceSource } from "@/lib/finance-sharing/contract";

/** Access management remains reachable even after the source portfolio is removed. */
export function FinanceSharingHistoryAction({ label = "Sharing", hasPortfolio = true, preferredSource, open: externalOpen, onOpenChange }: { label?: string; hasPortfolio?: boolean; preferredSource?: FinanceSource; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = externalOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  return <><ShellActionSurface variant="pill" onClick={() => setOpen(true)}>{label}</ShellActionSurface><FinanceSharingManager hasPortfolio={hasPortfolio} preferredSource={preferredSource} open={open} onOpenChange={setOpen} /></>;
}
