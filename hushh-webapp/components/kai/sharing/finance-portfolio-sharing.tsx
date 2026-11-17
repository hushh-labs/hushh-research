"use client";

import { useCallback, useEffect, useState } from "react";
import { normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { usePathname, useSearchParams } from "next/navigation";
import { SectionLabel } from "@/components/app-ui/typography";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import { FinanceShareFlow } from "./finance-share-flow";
import { FinanceSharingHistoryAction } from "./finance-sharing-history-action";

export type FinancePortfolioPresentation = { view: "share" | "advisor" | "history" | "report" | null; change: (view: FinancePortfolioPresentation["view"]) => void };
export function FinancePortfolioSharing({ model, source, presentation }: { model?: DashboardViewModel; source?: FinanceSource; presentation?: FinancePortfolioPresentation }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = presentation ? presentation.view === "share" || presentation.view === "advisor" : localOpen;
  const setOpen = useCallback((value: boolean) => presentation ? presentation.change(value ? "share" : null) : setLocalOpen(value), [presentation]);
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const params = useSearchParams();
  const active = pathname !== "/one/kai" || params.get("tab") === "portfolio";
  useEffect(() => { if (!active && open) setOpen(false); }, [active, open, setOpen]);
  return <SurfaceCard><SurfaceCardContent className="space-y-3 p-5 sm:p-6">
    <SectionLabel role="heading" aria-level={2}>Sharing</SectionLabel>
    <div className="flex flex-wrap gap-2">
      <ShellActionSurface variant="pill" className="min-h-11" disabled={!model || !source} onClick={() => setOpen(true)}>Share portfolio</ShellActionSurface>
      <FinanceSharingHistoryAction label="Manage sharing" hasPortfolio={Boolean(model && source)} preferredSource={source} open={presentation ? presentation.view === "history" : undefined} onOpenChange={presentation ? value => presentation.change(value ? "history" : null) : undefined} />
    </div>
    {!model || !source ? <p className="text-xs text-muted-foreground">Add a portfolio to share.</p> : null}
    {model && source ? <FinanceShareFlow open={open && active} onOpenChange={setOpen} model={model} source={source} /> : null}
  </SurfaceCardContent></SurfaceCard>;
}
