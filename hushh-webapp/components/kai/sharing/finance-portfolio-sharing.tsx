"use client";

import { useCallback, useEffect, useState } from "react";
import { normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { usePathname, useSearchParams } from "next/navigation";
import { SectionLabel } from "@/components/app-ui/typography";
import { useVoiceSurfaceActive } from "@/lib/kai/actions/voice-surface-activity";
import { Share2 } from "@/components/icons";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { FinanceShareFlow } from "./finance-share-flow";
import { FinanceSharingHistoryAction } from "./finance-sharing-history-action";

export type FinancePortfolioPresentation = {
  view: "share" | "advisor" | "history" | "report" | null;
  change: (view: FinancePortfolioPresentation["view"]) => void;
};

export function FinancePortfolioSharing({
  model,
  source,
  presentation,
}: {
  model?: DashboardViewModel;
  source?: FinanceSource;
  presentation?: FinancePortfolioPresentation;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [needsPortfolio, setNeedsPortfolio] = useState(false);
  const open = presentation
    ? presentation.view === "share" || presentation.view === "advisor"
    : localOpen;
  const setOpen = useCallback(
    (value: boolean) =>
      presentation ? presentation.change(value ? "share" : null) : setLocalOpen(value),
    [presentation],
  );
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const params = useSearchParams();
  const activeSurface = useVoiceSurfaceActive();
  const active = activeSurface && (pathname !== "/one/kai" || params.get("tab") === "portfolio");
  useEffect(() => {
    if (!active && open) setOpen(false);
  }, [active, open, setOpen]);
  useEffect(() => {
    if (model && source) setNeedsPortfolio(false);
  }, [model, source]);
  if (!active) return null;
  return (
    <SurfaceCard data-testid="portfolio-sharing-card" className={`${styles.portfolioSharingCard} app-type-compact`}>
      <SurfaceCardContent className={styles.portfolioSharingBody}>
        <div className={styles.portfolioSharingHeader}>
          <span className={styles.portfolioSharingIcon} aria-hidden="true"><Share2 size={18} inheritColor /></span>
          <SectionLabel role="heading" aria-level={2}>Sharing</SectionLabel>
        </div>
        <div className={styles.portfolioSharingActions}>
          <ShellActionSurface
            variant="pill"
            className={`${styles.portfolioSharingPrimary} ui-text-compact-button-label`}
            onClick={() => (model && source ? setOpen(true) : setNeedsPortfolio(true))}
          >
            Share portfolio
          </ShellActionSurface>
          <FinanceSharingHistoryAction
            label="Manage sharing"
            className="ui-text-compact-button-label"
            hasPortfolio={Boolean(model && source)}
            preferredSource={source}
            open={presentation ? presentation.view === "history" : undefined}
            onOpenChange={
              presentation
                ? (value) => presentation.change(value ? "history" : null)
                : undefined
            }
          />
        </div>
        {needsPortfolio && (!model || !source) ? (
          <p role="status" className={styles.portfolioSharingStatus}>
            Add a portfolio to share.
          </p>
        ) : null}
        {model && source ? (
          <FinanceShareFlow
            open={open && active}
            onOpenChange={setOpen}
            model={model}
            source={source}
          />
        ) : null}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
