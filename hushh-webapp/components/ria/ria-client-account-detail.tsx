"use client";

import Link from "next/link";

import { SectionHeader } from "@/components/app-ui/page-sections";
import {
  SettingsGroup,
  SettingsRow,
} from "@/components/profile/settings-ui";
import {
  MetricTile,
  RiaCompatibilityState,
  RiaPageShell,
} from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildRiaClientWorkspaceRoute,
} from "@/lib/navigation/routes";
import { useRiaClientWorkspaceState } from "@/components/ria/use-ria-client-workspace-state";
import { Database, Loader2, Wallet } from "lucide-react";

function formatStatusLabel(status?: string | null) {
  return String(status || "pending").replaceAll("_", " ");
}

function branchBadgeClass(status?: string | null) {
  switch (status) {
    case "approved":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "pending":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

export function RiaClientAccountDetail({
  clientId,
  accountId,
  forceTestProfile = false,
}: {
  clientId: string;
  accountId: string;
  forceTestProfile?: boolean;
}) {
  const {
    user,
    riaCapability,
    personaLoading,
    detail,
    workspace,
    loading,
    detailError,
    iamUnavailable,
    isTestProfile,
  } = useRiaClientWorkspaceState({
    clientId,
    forceTestProfile,
  });

  const accountBranch = (detail?.account_branches || workspace?.account_branches || []).find(
    (branch) =>
      branch.branch_id === accountId ||
      branch.account_id === accountId ||
      branch.persistent_account_id === accountId
  );
  const financialSummary = (workspace?.domain_summaries?.financial ||
    detail?.domain_summaries?.financial ||
    {}) as Record<string, unknown>;

  if (personaLoading) return null;

  if (riaCapability === "setup") {
    return (
      <RiaCompatibilityState
        title="Complete RIA onboarding"
        description="Finish onboarding before opening account detail routes."
      />
    );
  }

  if (iamUnavailable) {
    return (
      <RiaCompatibilityState
        title="Account detail is unavailable in this environment"
        description="The route is wired, but this environment still needs the full IAM schema before advisor-side account detail can load."
      />
    );
  }

  return (
    <RiaPageShell
      eyebrow="Account detail"
      title={accountBranch?.name || "Account"}
      description={
        detail?.investor_display_name
          ? `Advisor access for ${detail.investor_display_name}`
          : "Advisor-facing account detail"
      }
      icon={Wallet}
      nativeTest={{
        routeId: "/ria/clients/[userId]/accounts/[accountId]",
        marker: "native-route-ria-client-account-detail",
        authState: user ? "authenticated" : "pending",
        dataState: loading
          ? "loading"
          : accountBranch
            ? "loaded"
            : detailError
              ? "error"
              : "empty-valid",
        errorCode: detailError ? "ria_client_account_detail" : null,
        errorMessage: detailError,
      }}
    >
      {loading ? (
        <div className="rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-[var(--app-card-shadow-standard)]">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading account detail...
          </div>
        </div>
      ) : null}

      {!loading && detailError ? (
        <div className="rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-[var(--app-card-shadow-standard)]">
          <p className="text-sm text-red-500">{detailError}</p>
        </div>
      ) : null}

      {!loading && !detailError && !accountBranch ? (
        <SettingsGroup
          embedded
          title="Account not available"
          description="The account branch is not part of the current client workspace or has not been approved for this advisor view."
        >
          <SettingsRow
            title="Return to the client workspace"
            description="Use the workspace to review approved account coverage."
            trailing={
              <Button asChild variant="link" size="sm" className="h-auto px-0">
                <Link
                  href={buildRiaClientWorkspaceRoute(clientId, {
                    tab: "explorer",
                    testProfile: isTestProfile,
                  })}
                >
                  Open workspace
                </Link>
              </Button>
            }
          />
        </SettingsGroup>
      ) : null}

      {accountBranch ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile label="Status" value={formatStatusLabel(accountBranch.status)} />
            <MetricTile label="Institution" value={accountBranch.institution_name || "Unknown"} />
            <MetricTile label="Type" value={accountBranch.type || "Investment"} />
            <MetricTile label="Mask" value={accountBranch.mask ? `••${accountBranch.mask}` : "Unavailable"} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
            <section className="space-y-3">
              <SectionHeader
                eyebrow="Access"
                title="Approval and branch status"
                description="Per-account approval remains explicit. This route surfaces what the advisor can currently access for this branch."
                icon={Wallet}
                accent="ria"
              />
              <SettingsGroup embedded>
                <SettingsRow
                  title="Branch status"
                  description={formatStatusLabel(accountBranch.status)}
                  trailing={
                    <Badge className={branchBadgeClass(accountBranch.status)}>
                      {formatStatusLabel(accountBranch.status)}
                    </Badge>
                  }
                />
                <SettingsRow
                  title="Display name"
                  description={accountBranch.official_name || accountBranch.name}
                />
                <SettingsRow
                  title="Subtype"
                  description={accountBranch.subtype || "Not specified"}
                />
                <SettingsRow
                  title="Grant source"
                  description={accountBranch.granted_by_bundle_key || "Kai specialized access"}
                />
              </SettingsGroup>
            </section>

            <section className="space-y-3">
              <SectionHeader
                eyebrow="Explorer"
                title="Readable branch summary"
                description="This view stays intentionally summary-first until richer account-level explorer payloads are available from the backend."
                icon={Database}
                accent="ria"
              />
              <SettingsGroup embedded>
                <SettingsRow
                  title="Account coverage"
                  description="This advisor route currently inherits domain-level financial summaries plus explicit branch approval metadata."
                />
                <SettingsRow
                  title="Household risk"
                  description={String(financialSummary.risk_profile || "Unavailable")}
                />
                <SettingsRow
                  title="Known account count"
                  description={String(financialSummary.account_count || detail?.account_branches.length || 0)}
                />
                <SettingsRow
                  title="Known holdings"
                  description={String(financialSummary.holdings_count || detail?.total_attributes || 0)}
                />
              </SettingsGroup>
            </section>
          </div>
        </>
      ) : null}
    </RiaPageShell>
  );
}
