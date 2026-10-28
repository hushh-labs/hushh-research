"use client";

import { useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { FinanceSharingManager } from "./finance-sharing-manager";

/** Access management remains reachable even after the source portfolio is removed. */
export function FinanceSharingHistoryAction() {
  const [open, setOpen] = useState(false);
  return <><ShellActionSurface variant="pill" onClick={() => setOpen(true)}>Sharing</ShellActionSurface><FinanceSharingManager open={open} onOpenChange={setOpen} /></>;
}
