"use client";

import type { ComponentProps } from "react";
import { PortfolioBriefing } from "./portfolio-briefing";
import { PortfolioImportView } from "./portfolio-import-view";

/** Dashboard setup has no skip action; the owner can return to Finance at any time. */
export function PortfolioDashboardEmpty({ onOpenImport, ...props }: ComponentProps<typeof PortfolioImportView> & { onOpenImport: () => void }) {
  return <div className="space-y-4">
    <PortfolioBriefing onOpen={onOpenImport} />
    <PortfolioImportView {...props} showSkip={false} />
  </div>;
}
