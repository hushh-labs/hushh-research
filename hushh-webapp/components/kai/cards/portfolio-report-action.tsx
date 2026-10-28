"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Download, Loader2, Share2 } from "@/components/icons";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { FinanceShareFlow } from "@/components/kai/sharing/finance-share-flow";
import type { FinanceSource } from "@/lib/finance-sharing/contract";

export function PortfolioReportAction({ model, source, period, disabled, busy, onExport, sharingSource }: {
  model: DashboardViewModel; source: string; period: string; disabled?: boolean; busy?: boolean; onExport: () => void;
  sharingSource?: FinanceSource;
}) {
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const pathname = usePathname();
  const params = useSearchParams();
  const active = pathname !== "/one/kai" || params.get("tab") === "portfolio";
  const visible = open && active;
  useBackLayer(pathname, visible ? 1 : 0, () => { setOpen(false); return true; }, pathname === "/one/kai" ? { tab: "portfolio" } : undefined);
  const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  return <>
    <div className="flex items-center gap-2">
      {sharingSource ? <ShellActionSurface variant="icon" aria-label="Share Finance with connections" disabled={busy} onClick={() => setSharing(true)}><Share2 className="h-4 w-4" /></ShellActionSurface> : null}
      <ShellActionSurface variant="icon" aria-label="Share portfolio PDF" data-voice-control-id="share_portfolio_pdf" disabled={disabled || busy} onClick={() => setOpen(true)}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      </ShellActionSurface>
    </div>
    {sharingSource ? <FinanceShareFlow open={sharing && active} onOpenChange={setSharing} model={model} source={sharingSource} /> : null}
    <KaiControlSurface open={visible} onOpenChange={setOpen} title="Portfolio report" description={`${source} · ${period}`} surfaceClassName={styles.detail}
      footer={<ShellActionSurface variant="pill" disabled={busy} onClick={onExport}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Export PDF</ShellActionSurface>}>
      <div className="space-y-5">
        <div><p className={styles.description}>Portfolio value</p><p className={styles.value}>{money(model.hero.totalValue)}</p></div>
        <p className="text-sm leading-[21px] text-muted-foreground">The report includes your current holdings, allocation and available value history. Review the details before exporting.</p>
        {model.quality.historyReady ? <PortfolioHistoryChart data={model.history} height={180} /> : <p className={styles.description}>No value history is available for this source.</p>}
        <dl className={styles.facts}>{model.canonicalModel.positions.slice(0, 8).map(position => <div className={styles.fact} key={position.id}><dt>{position.displaySymbol || position.name}</dt><dd>{money(position.marketValue)}</dd></div>)}</dl>
        <p className={styles.description}>Exporting creates a file on your device. It does not publish a public link.</p>
      </div>
    </KaiControlSurface>
  </>;
}
