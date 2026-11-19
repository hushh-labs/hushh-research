"use client";

import type { ComponentProps } from "react";
import { PortfolioImportView } from "./portfolio-import-view";
import { FinancePortfolioSharing } from "@/components/kai/sharing/finance-portfolio-sharing";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";

export function PortfolioDashboardEmpty(props: ComponentProps<typeof PortfolioImportView>) {
  return (
    <div className={financeStyles.workspace + " mx-auto w-full max-w-[880px] space-y-4"}>
      <PortfolioImportView {...props} presentation="dashboard" />
      <FinancePortfolioSharing />
    </div>
  );
}
