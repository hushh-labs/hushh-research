"use client";

import { useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { FinanceSharingManager } from "./finance-sharing-manager";

/** Access management remains reachable even after the source portfolio is removed. */
export function FinanceSharingHistoryAction({ label = "Sharing", hasPortfolio = true }: { label?: string; hasPortfolio?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><ShellActionSurface variant="pill" onClick={() => setOpen(true)}>{label}</ShellActionSurface><FinanceSharingManager hasPortfolio={hasPortfolio} open={open} onOpenChange={setOpen} /></>;
}
