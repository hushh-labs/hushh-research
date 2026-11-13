"use client";

import type { ReactNode } from "react";
import { AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Card, CardHeader, CardTitle, CardContent } from "@/lib/morphy-ux/card";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { cn } from "@/lib/utils";

/** Loading and editable review share these shells, insets and action tracks. */
export function PortfolioReviewFrame({ actions, status, children, className, description }: {
  actions?: ReactNode; status?: ReactNode; children: ReactNode; className?: string; description?: string;
}) {
  return <AppPageContentRegion className={cn(financeStyles.detail, "relative min-w-0 space-y-4 pb-4", className)}>
    <PageHeader title="Review holdings" accent="neutral" actionsInlineMobile className={financeStyles.compactPageHeader}
      description={description} actions={actions} />
    {status}
    {children}
  </AppPageContentRegion>;
}

export function PortfolioReviewSection({ value, title, icon, pending, pendingContent, children }: {
  value: string; title: string; icon: ReactNode; pending?: boolean; pendingContent?: ReactNode; children?: ReactNode;
}) {
  return <AccordionItem value={value} className="border-b-0 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-default)] px-5 shadow-[var(--app-card-shadow-standard)]">
    <AccordionTrigger disabled={pending} className="ui-text-section-label py-3 hover:no-underline">
      <span className="flex items-center gap-2">{icon}{title}</span>
    </AccordionTrigger>
    {pending && pendingContent ? <div className="pb-4">{pendingContent}</div> : null}
    <AccordionContent>{children}</AccordionContent>
  </AccordionItem>;
}

export function PortfolioReviewHoldingsPanel({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return <Card variant="none" preset="surface" className="min-w-0">
    <CardHeader className="flex items-center justify-between gap-2 space-y-0 px-4 pb-2 pt-3">
      <CardTitle className="ui-text-section-label">Holdings</CardTitle>
      {actions}
    </CardHeader>
    <CardContent className="min-w-0 px-4 pb-4 pt-0">{children}</CardContent>
  </Card>;
}
