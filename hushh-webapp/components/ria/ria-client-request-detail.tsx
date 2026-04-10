"use client";

import Link from "next/link";
import { ClipboardList, Loader2 } from "lucide-react";

import { SectionHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import {
  MetricTile,
  RiaCompatibilityState,
  RiaPageShell,
} from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildRiaClientWorkspaceRoute } from "@/lib/navigation/routes";
import { useRiaClientWorkspaceState } from "@/components/ria/use-ria-client-workspace-state";

function formatStatusLabel(status?: string | null) {
  return String(status || "pending").replaceAll("_", " ");
}

function formatDate(value?: string | number | null) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return date.toLocaleString();
}

function statusBadgeClass(status?: string | null) {
  switch (status) {
    case "approved":
    case "active":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "pending":
    case "request_pending":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

export function RiaClientRequestDetail({
  clientId,
  requestId,
  forceTestProfile = false,
}: {
  clientId: string;
  requestId: string;
  forceTestProfile?: boolean;
}) {
  const {
    user,
    riaCapability,
    personaLoading,
    detail,
    loading,
    detailError,
    iamUnavailable,
    isTestProfile,
  } = useRiaClientWorkspaceState({
    clientId,
    forceTestProfile,
  });

  const request = detail?.request_history.find((entry) => entry.request_id === requestId) || null;

  if (personaLoading) return null;

  if (riaCapability === "setup") {
    return (
      <RiaCompatibilityState
        title="Complete RIA onboarding"
        description="Finish onboarding before opening request detail routes."
      />
    );
  }

  if (iamUnavailable) {
    return (
      <RiaCompatibilityState
        title="Request detail is unavailable in this environment"
        description="The route is wired, but this environment still needs the full IAM schema before advisor-side request detail can load."
      />
    );
  }

  return (
    <RiaPageShell
      eyebrow="Request detail"
      title={request?.scope_metadata?.label || request?.scope || "Request"}
      description={
        detail?.investor_display_name
          ? `Access request history for ${detail.investor_display_name}`
          : "Advisor-facing request detail"
      }
      icon={ClipboardList}
      nativeTest={{
        routeId: "/ria/clients/[userId]/requests/[requestId]",
        marker: "native-route-ria-client-request-detail",
        authState: user ? "authenticated" : "pending",
        dataState: loading ? "loading" : request ? "loaded" : detailError ? "error" : "empty-valid",
        errorCode: detailError ? "ria_client_request_detail" : null,
        errorMessage: detailError,
      }}
    >
      {loading ? (
        <div className="rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-[var(--app-card-shadow-standard)]">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading request detail...
          </div>
        </div>
      ) : null}

      {!loading && detailError ? (
        <div className="rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-[var(--app-card-shadow-standard)]">
          <p className="text-sm text-red-500">{detailError}</p>
        </div>
      ) : null}

      {!loading && !detailError && !request ? (
        <SettingsGroup
          embedded
          title="Request not available"
          description="This request is not part of the current client workspace history or the identifier is no longer valid."
        >
          <SettingsRow
            title="Return to client access"
            description="Use the client workspace to review active access and recent relationship activity."
            trailing={
              <Button asChild variant="link" size="sm" className="h-auto px-0">
                <Link
                  href={buildRiaClientWorkspaceRoute(clientId, {
                    tab: "access",
                    testProfile: isTestProfile,
                  })}
                >
                  Open access
                </Link>
              </Button>
            }
          />
        </SettingsGroup>
      ) : null}

      {request ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile label="Action" value={formatStatusLabel(request.action)} />
            <MetricTile label="Bundle" value={request.bundle_label || "Direct request"} />
            <MetricTile label="Issued" value={formatDate(request.issued_at)} />
            <MetricTile label="Expires" value={formatDate(request.expires_at)} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
            <section className="space-y-3">
              <SectionHeader
                eyebrow="Request"
                title="Access request summary"
                description="This route keeps request context readable without forcing the advisor back into the main workspace list."
                icon={ClipboardList}
                accent="ria"
              />
              <SettingsGroup embedded>
                <SettingsRow
                  title="Status"
                  description={formatStatusLabel(request.action)}
                  trailing={
                    <Badge className={statusBadgeClass(request.action)}>
                      {formatStatusLabel(request.action)}
                    </Badge>
                  }
                />
                <SettingsRow
                  title="Scope"
                  description={request.scope_metadata?.description || request.scope || "Unavailable"}
                />
                <SettingsRow
                  title="Bundle"
                  description={request.bundle_label || "No bundle metadata"}
                />
                <SettingsRow
                  title="Request ID"
                  description={request.request_id || "Unavailable"}
                />
              </SettingsGroup>
            </section>

            <section className="space-y-3">
              <SectionHeader
                eyebrow="Coverage"
                title="Client access framing"
                description="Account branches and Kai/explorer access are still governed from the client workspace. This detail route stays intentionally focused on request metadata."
                icon={ClipboardList}
                accent="ria"
              />
              <SettingsGroup embedded>
                <SettingsRow
                  title="Client"
                  description={detail?.investor_display_name || detail?.investor_email || clientId}
                />
                <SettingsRow
                  title="Relationship status"
                  description={formatStatusLabel(detail?.relationship_status)}
                />
                <SettingsRow
                  title="Approved scopes"
                  description={String(detail?.granted_scopes.length || 0)}
                />
                <SettingsRow
                  title="Approved accounts"
                  description={String(detail?.account_branches.filter((branch) => branch.status === "approved").length || 0)}
                />
              </SettingsGroup>
            </section>
          </div>
        </>
      ) : null}
    </RiaPageShell>
  );
}
