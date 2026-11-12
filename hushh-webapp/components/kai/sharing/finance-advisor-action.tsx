"use client";

import { useEffect, useState } from "react";
import { normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { usePathname, useSearchParams } from "next/navigation";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import { FinanceShareFlow } from "./finance-share-flow";

export function FinanceAdvisorAction({ model, source, open: externalOpen, onOpenChange }: { model: DashboardViewModel; source: FinanceSource; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = externalOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const params = useSearchParams();
  const active = pathname !== "/one/kai" || params.get("tab") === "portfolio";
  useEffect(() => { if (!active && open) setOpen(false); }, [active, open, setOpen]);
  return <>
    <ShellActionSurface variant="pill" className="min-h-11" onClick={() => setOpen(true)}>Ask an advisor</ShellActionSurface>
    <FinanceShareFlow advisorOnly open={open && active} onOpenChange={setOpen} model={model} source={source} />
  </>;
}
