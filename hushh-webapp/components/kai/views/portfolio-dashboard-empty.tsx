"use client";

import type { ComponentProps } from "react";
import { PortfolioImportView } from "./portfolio-import-view";
import { FinancePortfolioSharing } from "@/components/kai/sharing/finance-portfolio-sharing";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";

/** Dashboard setup has no skip action; the owner can return to Finance at any time. */
export function PortfolioDashboardEmpty({ onOpenAnalysis, ...props }: ComponentProps<typeof PortfolioImportView> & {
  onOpenAnalysis: () => void;
}) {
  return <div className={`${financeStyles.workspace} space-y-4`}>
    <PortfolioImportView {...props} showSkip={false} />
    <ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" data-voice-control-id="open_portfolio_analysis" onClick={onOpenAnalysis}>
      View net worth score
    </ShellActionSurface>
    <FinancePortfolioSharing />
  </div>;
}
