import type { ReactNode } from "react";

import { AppPageHeaderRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";

type KaiWorkspace = "market" | "portfolio" | "analysis";

/**
 * The sole primary-header composition for the query-tabbed Kai workspace.
 * Each tab supplies only its copy/actions; the Profile-aligned region and
 * divider remain shared. The route-level Finance header and tab rail own the
 * stable workspace identity. These per-panel headings remain assistive-only:
 * a visible Market/Portfolio/Analysis heading would duplicate the active tab
 * and slide away with every panel change.
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
