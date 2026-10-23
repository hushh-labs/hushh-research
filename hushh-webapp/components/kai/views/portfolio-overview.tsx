"use client";

import type { ReactNode } from "react";
import { ChartNoAxesCombined, Database, Layers3, WalletCards } from "@/components/icons";
import { SectionLabel } from "@/components/app-ui/typography";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { PortfolioValueCard } from "@/components/kai/cards/portfolio-value-card";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import type { DashboardViewModel } from "./dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import type { KaiPortfolioSection } from "@/lib/navigation/routes";

import { overviewFacts } from "./portfolio-display-facts";

export function PortfolioOverview({ model, portfolio, source, period, action, onOpenSection }: {
  model: DashboardViewModel; portfolio?: PortfolioData | null; source: string;
  period: string; action?: ReactNode; onOpenSection: (section: KaiPortfolioSection) => void;
}) {
  const facts = overviewFacts(model, portfolio);
  const primary = model.allocation[0];
  const allocation = primary && model.hero.totalValue > 0 ? `${primary.name} ${(primary.value / model.hero.totalValue * 100).toFixed(1)}%` : "Unavailable";
  const rows = [
    { section: "holdings" as const, icon: WalletCards, title: "Holdings", description: `${model.hero.holdingsCount} ${model.hero.holdingsCount === 1 ? "position" : "positions"} · ${source} prices`, value: String(model.hero.holdingsCount) },
    { section: "allocation" as const, icon: Layers3, title: "Allocation", description: "How your portfolio is invested", value: allocation },
    { section: "performance" as const, icon: ChartNoAxesCombined, title: "Performance", description: model.quality.historyReady ? "From saved portfolio history" : "Snapshot and balance details", value: facts.changePct === null ? "Unavailable" : `${facts.changePct > 0 ? "+" : ""}${facts.changePct.toFixed(2)}%` },
    { section: "sources" as const, icon: Database, title: "Portfolio source", description: model.sourceBrokerage || "Manage statements and connections", value: source },
  ];
  return <div className={styles.overviewGrid} data-testid="portfolio-overview">
    <SectionLabel role="heading" aria-level={2} className="col-span-full">Your portfolio</SectionLabel>
    <PortfolioValueCard source={source} value={model.hero.totalValue} {...facts} period={period} history={model.quality.historyReady ? model.history : []} action={action} />
    <SettingsGroup embedded separatorInset testId="portfolio-overview-options">
      {rows.map(row => <SettingsRow key={row.section} icon={row.icon} iconTone="gray" title={row.title} description={row.description}
        trailing={<span className="max-w-32 text-right text-xs leading-[18px] tabular-nums text-muted-foreground">{row.value}</span>}
        onClick={() => onOpenSection(row.section)} chevron testId={`portfolio-open-${row.section}`} />)}
    </SettingsGroup>
  </div>;
}
