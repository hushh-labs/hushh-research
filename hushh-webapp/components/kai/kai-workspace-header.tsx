import type { ReactNode } from "react";

import { AppPageHeaderRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";

type KaiWorkspace = "market" | "portfolio" | "analysis";

/**
 * The sole primary-header composition for the query-tabbed Kai workspace.
 * Each tab supplies only its copy/actions; the Profile-aligned region and
 * divider remain shared. Finance intentionally has no feature icon here:
 * the shell tabs already identify the active workspace.
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
    <AppPageHeaderRegion data-kai-workspace-header={workspace}>
      <PageHeader
        title={title}
        description={description}
        actions={actions}
        actionsInlineMobile={actionsInlineMobile}
        className={className}
      />
    </AppPageHeaderRegion>
  );
}
