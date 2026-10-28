"use client";

import { useState } from "react";
import { FinanceSharedDetail } from "./finance-shared-detail";

export function FinanceShareMessage({ grantId }: { grantId: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="min-h-11 rounded-xl border border-border bg-card px-4 py-3 text-left" onClick={() => setOpen(true)}><span className="block text-sm font-semibold">Shared Finance</span><span className="mt-1 block text-xs text-muted-foreground">Open the approved view</span></button><FinanceSharedDetail grantId={open ? grantId : null} onClose={() => setOpen(false)} /></>;
}
