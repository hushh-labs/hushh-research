"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { SectionLabel } from "@/components/app-ui/typography";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import { FinanceAdvisorAction } from "./finance-advisor-action";
import { FinanceShareFlow } from "./finance-share-flow";
import { FinanceSharingHistoryAction } from "./finance-sharing-history-action";

export function FinancePortfolioSharing({ model, source }: { model: DashboardViewModel; source: FinanceSource }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const params = useSearchParams();
  const active = pathname !== "/one/kai" || params.get("tab") === "portfolio";
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  return <SurfaceCard><SurfaceCardContent className="space-y-3 p-5 sm:p-6">
    <SectionLabel role="heading" aria-level={2}>Sharing</SectionLabel>
    <div className="flex flex-wrap gap-2">
      <FinanceAdvisorAction model={model} source={source} />
      <ShellActionSurface variant="pill" className="min-h-11" onClick={() => setOpen(true)}>Share portfolio</ShellActionSurface>
      <FinanceSharingHistoryAction label="Manage sharing" />
    </div>
    <FinanceShareFlow open={open && active} onOpenChange={setOpen} model={model} source={source} />
  </SurfaceCardContent></SurfaceCard>;
}
