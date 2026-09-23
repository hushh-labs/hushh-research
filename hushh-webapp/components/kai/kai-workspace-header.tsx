import type { ReactNode } from "react";

import { AppPageHeaderRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";

type KaiWorkspace = "market" | "portfolio" | "analysis";

/**
 * The sole primary-header composition for the query-tabbed Kai workspace.
 * Each tab supplies only its copy/actions; the Profile-aligned region and
 * divider remain shared. Finance intentionally has no feature icon here:
 * the shell tabs already identify the active workspace, and for the same
 * reason the title is not drawn (it stays in the document): the bar reads
 * "Finance" and the tab reads "Market", so a large "Market" under them was
 * the third name for one screen, and it lives in the swipe panel, so it slid
 * away with every tab change. The Consent Center has never drawn one.
 */
export function KaiWorkspaceHeader({
  workspace,
  title,
  description,
  actions,
  actionsInlineMobile = false,
  className,
}: {
  workspace: KaiWorkspace;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  actionsInlineMobile?: boolean;
  className?: string;
}) {
  return (
    <AppPageHeaderRegion
      className="mb-[var(--page-header-section-gap)]"
      data-kai-workspace-header={workspace}
    >
      <PageHeader
        title={title}
        description={description}
        actions={actions}
        actionsInlineMobile={actionsInlineMobile}
        accent="neutral"
        titleVisuallyHidden
        className={className}
      />
    </AppPageHeaderRegion>
  );
}
