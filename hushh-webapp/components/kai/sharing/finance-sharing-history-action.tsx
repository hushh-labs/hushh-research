"use client";

import { useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { FinanceSharingManager } from "./finance-sharing-manager";

/** Access management remains reachable even after the source portfolio is removed. */
export function FinanceSharingHistoryAction({ label = "Sharing", open: externalOpen, onOpenChange }: { label?: string; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = externalOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  return <><ShellActionSurface variant="pill" onClick={() => setOpen(true)}>{label}</ShellActionSurface><FinanceSharingManager open={open} onOpenChange={setOpen} /></>;
}
