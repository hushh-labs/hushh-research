"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Unplug,
} from "lucide-react";

import { PopupTextEditorField } from "@/components/app-ui/command-fields";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
import {
  RiaCompatibilityState,
  RiaPageShell,
  RiaSurface,
} from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { buildRiaConsentManagerHref } from "@/lib/consent/consent-sheet-route";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { Button } from "@/lib/morphy-ux/button";
import {
  buildRiaClientAccountRoute,
  buildRiaClientWorkspaceRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import {
  RiaService,
  type RiaAccountBranch,
  type RiaAvailableScopeMetadata,
  type RiaClientDetail,
  type RiaRequestScopeTemplate,
} from "@/lib/services/ria-service";
import { useRiaClientWorkspaceState } from "@/components/ria/use-ria-client-workspace-state";

type WorkspaceTab = "overview" | "access" | "kai" | "explorer";

function formatStatusLabel(status?: string | null) {
  return String(status || "pending").replaceAll("_", " ");
}

function formatDate(value?: string | number | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function statusBadgeClass(status?: string | null) {
  switch (status) {
    case "approved":
    case "active":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "request_pending":
    case "pending":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

function branchBadgeClass(status: RiaAccountBranch["status"]) {
  switch (status) {
    case "approved":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "pending":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asPercent(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 1) return `${Math.round(numeric * 100)}%`;
  return `${Math.round(numeric)}%`;
}

function scalarSummaryRows(financial: Record<string, unknown>) {
  const allocation = asRecord(financial.asset_allocation_pct);
  const keys = [
    ["Risk profile", financial.risk_profile],
    [
      "Holdings",
      financial.holdings_count ||
        financial.investable_positions_count ||
        financial.item_count ||
        financial.attribute_count,
    ],
    ["Accounts", financial.account_count],
    ["Cash", asPercent(allocation.cash)],
    ["Equities", asPercent(allocation.equities)],
    ["Bonds", asPercent(allocation.bonds)],
  ] as const;
  return keys.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
}

const ALLOCATION_COLORS: Record<string, string> = {
  equities: "#7dd3fc",
  bonds: "#fbbf24",
  cash: "#6ee7b7",
  other: "#94a3b8",
};

function AllocationBar({ allocation }: { allocation: Record<string, unknown> }) {
  const segments = ["equities", "bonds", "cash", "other"]
    .map((key) => ({ key, value: Number(allocation[key]) || 0 }))
    .filter((segment) => segment.value > 0);
  if (segments.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className="h-full transition-all"
            style={{
              width: `${Math.round(segment.value * 100)}%`,
              backgroundColor: ALLOCATION_COLORS[segment.key] || ALLOCATION_COLORS.other,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.map((segment) => (
          <span key={segment.key} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: ALLOCATION_COLORS[segment.key] || ALLOCATION_COLORS.other }}
            />
            <span className="capitalize">{segment.key}</span>
            <span className="font-medium text-foreground">{Math.round(segment.value * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function defaultScopesForTemplate(
  detail: RiaClientDetail,
  template: RiaRequestScopeTemplate | null
) {
  if (!template) return [];
  const available = new Set(
    detail.available_scope_metadata
      .filter((scope) => scope.available !== false)
      .map((scope) => scope.scope)
  );
  return template.scopes
    .map((scope) => scope.scope)
    .filter((scope) => available.has(scope));
}

function visibleScopesForTemplate(
  detail: RiaClientDetail,
  template: RiaRequestScopeTemplate | null
): RiaAvailableScopeMetadata[] {
  if (!template) return [];
  const availableByScope = new Map(
    detail.available_scope_metadata.map((scope) => [scope.scope, scope])
  );
  return template.scopes
    .map((scope) => availableByScope.get(scope.scope) || null)
    .filter((scope): scope is RiaAvailableScopeMetadata => Boolean(scope));
}

function defaultAccountIdsForTemplate(
  detail: RiaClientDetail,
  template: RiaRequestScopeTemplate | null
) {
  if (!template?.requires_account_selection) return [];
  const branchIds = detail.account_branches.map((branch) => branch.branch_id);
  if (detail.kai_specialized_bundle?.selected_account_ids?.length) {
    return detail.kai_specialized_bundle.selected_account_ids.filter((branchId) =>
      branchIds.includes(branchId)
    );
  }
  return branchIds;
}

function explorerDomainSummary(domainKey: string, summary: unknown) {
  const record = asRecord(summary);
  if (domainKey === "financial") {
    return [
      `Holdings ${String(record.holdings_count || record.attribute_count || 0)}`,
      record.risk_profile ? `Risk ${String(record.risk_profile)}` : null,
      record.account_count ? `Accounts ${String(record.account_count)}` : null,
    ]
      .filter(Boolean)
      .join(" • ");
  }
  const keys = Object.keys(record);
  return keys.length > 0 ? `${keys.length} summary fields indexed` : "Summary unavailable";
}

function formatDomainLabel(value: string) {
  return value
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function portfolioViewHelper(status?: string | null) {
  if (status === "active") {
    return "The shared portfolio and data views are ready.";
  }
  if (status === "partial") {
    return "Some access is approved, but more account coverage is still pending.";
  }
  if (status === "pending") {
    return "The client still needs to review this access request.";
  }
  return "Access has not been approved yet.";
}

function requestTemplateLabel(template: RiaRequestScopeTemplate) {
  const value = String(template.template_name || "").trim();
  if (!value) return "Client data";
  if (/kai/i.test(value)) return "Portfolio + data";
  return value;
}

export function RiaClientWorkspace({
  clientId,
  initialTab = "overview",
  forceTestProfile = false,
}: {
  clientId: string;
  initialTab?: WorkspaceTab;
  forceTestProfile?: boolean;
}) {
  const router = useRouter();
  const {
    user,
    riaCapability,
    personaLoading,
    isTestProfile,
    detail,
    workspace,
    loading,
    detailError,
    iamUnavailable,
    refreshWorkspace,
  } = useRiaClientWorkspaceState({
    clientId,
    forceTestProfile,
  });

  const [activeTab, setActiveTab] = useState<WorkspaceTab>(initialTab);
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [requestReason, setRequestReason] = useState("");

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const activeTemplate =
    detail?.requestable_scope_templates.find((template) => template.template_id === selectedTemplateId) ||
    detail?.requestable_scope_templates[0] ||
    null;
  const availableScopeOptions = useMemo(
    () => (detail ? visibleScopesForTemplate(detail, activeTemplate) : []),
    [activeTemplate, detail]
  );
  const consentManagerHref = buildRiaConsentManagerHref("pending", {
    from: buildRiaClientWorkspaceRoute(clientId, {
      tab: activeTab,
      testProfile: isTestProfile,
    }),
  });

  useEffect(() => {
    if (!detail) return;
    const defaultTemplate =
      detail.requestable_scope_templates.find((template) => template.template_id === selectedTemplateId) ||
      detail.requestable_scope_templates[0] ||
      null;
    setSelectedTemplateId(defaultTemplate?.template_id || "");
    setSelectedScopes(defaultScopesForTemplate(detail, defaultTemplate));
    setSelectedAccountIds(defaultAccountIdsForTemplate(detail, defaultTemplate));
  }, [detail, selectedTemplateId]);

  async function handleDisconnect() {
    if (!user || !detail || isTestProfile) return;
    try {
      setDisconnecting(true);
      const idToken = await user.getIdToken();
      await ConsentCenterService.disconnectRelationship({
        idToken,
        investor_user_id: detail.investor_user_id,
      });
      toast.success("Relationship disconnected", {
        description: "Access ended immediately. History stays available if you reconnect.",
      });
      router.push(ROUTES.RIA_CLIENTS);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to disconnect relationship");
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleRequestAccess() {
    if (!user || !detail || !activeTemplate || isTestProfile) return;
    if (selectedScopes.length === 0) {
      toast.error("Select at least one access area to request.");
      return;
    }
    if (activeTemplate.requires_account_selection && selectedAccountIds.length === 0) {
      toast.error("Select at least one account for this request.");
      return;
    }

    try {
      setRequestingAccess(true);
      const idToken = await user.getIdToken();
      await RiaService.createRequestBundle(idToken, {
        subject_user_id: detail.investor_user_id,
        scope_template_id: activeTemplate.template_id,
        selected_scopes: selectedScopes,
        selected_account_ids: activeTemplate.requires_account_selection ? selectedAccountIds : [],
        reason: requestReason.trim() || undefined,
      });
      toast.success("Access request sent", {
        description: "The client can review it in Access Manager.",
      });
      setRequestReason("");
      await refreshWorkspace();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send access request");
    } finally {
      setRequestingAccess(false);
    }
  }

  const activeBundle = detail?.kai_specialized_bundle || workspace?.kai_specialized_bundle || null;
  const activeAccountBranches = detail?.account_branches || workspace?.account_branches || [];
  const financialSummary = asRecord(asRecord(workspace?.domain_summaries || detail?.domain_summaries).financial);
  const summaryRows = scalarSummaryRows(financialSummary);
  const approvedAccountCount = activeAccountBranches.filter((branch) => branch.status === "approved").length;

  if (personaLoading) {
    return null;
  }

  if (riaCapability === "setup") {
    return (
      <RiaCompatibilityState
        title="Complete RIA onboarding"
        description="Finish onboarding before opening dedicated client workspaces."
      />
    );
  }

  return (
    <RiaPageShell
      width="expanded"
      eyebrow="Client"
      title={detail?.investor_display_name || "Investor workspace"}
      description={
        detail?.investor_email ||
        detail?.investor_secondary_label ||
        detail?.investor_headline ||
        "Client summary, portfolio, and key data stay together here."
      }
      nativeTest={{
        routeId: "/ria/clients/[userId]",
        marker: "native-route-ria-client-workspace",
        authState: user ? "authenticated" : "pending",
        dataState: loading
          ? "loading"
          : iamUnavailable
            ? "unavailable-valid"
            : workspace || detail
              ? "loaded"
              : "empty-valid",
        errorCode: detailError ? "ria_client_workspace" : null,
        errorMessage: detailError,
      }}
      actions={
        detail && !detail.is_self_relationship && !isTestProfile ? (
          <Button
            variant="none"
            effect="fade"
            size="sm"
            onClick={() => void handleDisconnect()}
            disabled={disconnecting}
          >
            {disconnecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unplug className="mr-2 h-4 w-4" />}
            Disconnect
          </Button>
        ) : null
      }
    >
      {iamUnavailable ? (
        <RiaCompatibilityState
          title="Client workspace is unavailable in this environment"
          description="The route is wired correctly, but this environment still needs the full IAM schema before advisor workspaces can read investor data."
        />
      ) : null}

      {loading ? (
        <RiaSurface className="p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading client workspace...
          </div>
        </RiaSurface>
      ) : null}

      {detailError && !iamUnavailable ? (
        <RiaSurface tone="critical" className="p-4">
          <p className="text-sm text-red-500">{detailError}</p>
        </RiaSurface>
      ) : null}

      {detail ? (
        <>
          <SettingsSegmentedTabs
            value={activeTab}
            onValueChange={(value) => {
              const nextTab = value as WorkspaceTab;
              setActiveTab(nextTab);
              router.replace(
                buildRiaClientWorkspaceRoute(clientId, {
                  tab: nextTab,
                  testProfile: isTestProfile,
                }),
                {
                  scroll: false,
                }
              );
            }}
            options={[
              { value: "overview", label: "Overview" },
              { value: "access", label: "Sharing" },
              { value: "kai", label: "Portfolio" },
              { value: "explorer", label: "Data" },
            ]}
          />

          {activeTab === "overview" ? (
            <div className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]">
              <RiaSurface className="space-y-3 p-4 sm:p-5">
                <div className="space-y-1">
                  <p className="text-sm font-semibold tracking-tight text-foreground">At a glance</p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    The current relationship state and what is ready right now.
                  </p>
                </div>
                <SettingsGroup embedded>
                  <SettingsRow title="Relationship" description={formatStatusLabel(detail.relationship_status)} />
                  <SettingsRow title="Portfolio" description={portfolioViewHelper(activeBundle?.status)} />
                  <SettingsRow
                    title="Accounts ready"
                    description={
                      approvedAccountCount > 0
                        ? `${approvedAccountCount} account${approvedAccountCount === 1 ? "" : "s"} ready to view`
                        : "No accounts are ready yet"
                    }
                  />
                  <SettingsRow
                    title="Next step"
                    description={detail.next_action || "Everything is ready for the next review."}
                  />
                </SettingsGroup>
              </RiaSurface>

              <RiaSurface className="space-y-3 p-4 sm:p-5">
                <div className="space-y-1">
                  <p className="text-sm font-semibold tracking-tight text-foreground">Accounts</p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Open an account to view the client summary for that account.
                  </p>
                </div>
                <SettingsGroup embedded>
                  {activeAccountBranches.length === 0 ? (
                    <div className="px-4 py-4 text-sm text-muted-foreground">
                      No linked accounts discovered yet.
                    </div>
                  ) : (
                    activeAccountBranches.map((branch) => (
                      <SettingsRow
                        key={branch.branch_id}
                        title={`${branch.name}${branch.mask ? ` ••${branch.mask}` : ""}`}
                        description={
                          [branch.institution_name, branch.type, branch.subtype]
                            .filter(Boolean)
                            .join(" • ") || "Linked account"
                        }
                        trailing={
                          <Badge className={statusBadgeClass(branch.status)}>
                            {formatStatusLabel(branch.status)}
                          </Badge>
                        }
                        onClick={() =>
                          router.push(
                            buildRiaClientAccountRoute(clientId, branch.branch_id, {
                              testProfile: isTestProfile,
                            })
                          )
                        }
                        chevron
                      />
                    ))
                  )}
                </SettingsGroup>
              </RiaSurface>
            </div>
          ) : null}

          {activeTab === "access" ? (
            <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
              <RiaSurface className="space-y-3 p-4 sm:p-5" data-testid="ria-client-workspace-access">
                <div className="space-y-1">
                  <p className="text-sm font-semibold tracking-tight text-foreground">Current sharing</p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    What the client already shares with you today.
                  </p>
                </div>
                <SettingsGroup embedded>
                  {detail.granted_scopes.length === 0 ? (
                    <div className="px-4 py-4 text-sm text-muted-foreground">No active sharing yet.</div>
                  ) : (
                    detail.granted_scopes.map((scope) => (
                      <SettingsRow
                        key={scope.scope}
                        title={scope.label}
                        description={
                          formatDate(scope.issued_at)
                            ? `Shared ${formatDate(scope.issued_at)}`
                            : "Available now"
                        }
                        trailing={
                          <span className="text-xs text-muted-foreground">
                            {formatDate(scope.expires_at) || "No expiry"}
                          </span>
                        }
                      />
                    ))
                  )}
                  {activeAccountBranches.map((branch) => (
                    <SettingsRow
                      key={branch.branch_id}
                      title={`${branch.name}${branch.mask ? ` ••${branch.mask}` : ""}`}
                      description={
                        [branch.institution_name, branch.type, branch.subtype]
                          .filter(Boolean)
                          .join(" • ") || "Linked account"
                      }
                      trailing={
                        <Badge className={branchBadgeClass(branch.status)}>
                          {formatStatusLabel(branch.status)}
                        </Badge>
                      }
                      onClick={() =>
                        router.push(
                          buildRiaClientAccountRoute(clientId, branch.branch_id, {
                            testProfile: isTestProfile,
                          })
                        )
                      }
                      chevron
                    />
                  ))}
                </SettingsGroup>
              </RiaSurface>

              <RiaSurface className="space-y-4 p-4 sm:p-5">
                <div className="space-y-1">
                  <p className="text-sm font-semibold tracking-tight text-foreground">Request more</p>
                  <p className="text-sm leading-6 text-muted-foreground">Choose what you need, then send it to the client for approval.</p>
                </div>
                {detail.requestable_scope_templates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Requests are not ready for this client yet.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {detail.requestable_scope_templates.map((template) => (
                        <Button
                          key={template.template_id}
                          variant={selectedTemplateId === template.template_id ? "blue-gradient" : "none"}
                          effect={selectedTemplateId === template.template_id ? "fill" : "fade"}
                          size="sm"
                          onClick={() => {
                            setSelectedTemplateId(template.template_id);
                            setSelectedScopes(defaultScopesForTemplate(detail, template));
                            setSelectedAccountIds(defaultAccountIdsForTemplate(detail, template));
                          }}
                        >
                          {requestTemplateLabel(template)}
                        </Button>
                      ))}
                    </div>

                    {availableScopeOptions.length > 0 ? (
                      <div className="space-y-2.5">
                        {availableScopeOptions.map((scope) => {
                          const checked = selectedScopes.includes(scope.scope);
                          return (
                            <label
                              key={scope.scope}
                              className="flex items-start gap-3 rounded-[20px] border border-border/60 bg-background/70 px-4 py-3"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(next) => {
                                  const shouldCheck = Boolean(next);
                                  setSelectedScopes((current) =>
                                    shouldCheck
                                      ? [...new Set([...current, scope.scope])]
                                      : current.filter((value) => value !== scope.scope)
                                  );
                                }}
                                className="mt-1"
                              />
                              <div className="space-y-1">
                                <p className="text-sm font-medium text-foreground">{scope.label}</p>
                                <p className="text-xs leading-5 text-muted-foreground">{scope.description}</p>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    ) : null}

                    {activeTemplate?.requires_account_selection ? (
                      <SettingsGroup embedded title="Choose accounts">
                        {activeAccountBranches.length === 0 ? (
                          <div className="px-4 py-4 text-sm text-muted-foreground">
                            No linked accounts are available for account-level approval yet.
                          </div>
                        ) : (
                          activeAccountBranches.map((branch) => {
                            const checked = selectedAccountIds.includes(branch.branch_id);
                            return (
                              <label
                                key={branch.branch_id}
                                className="flex items-start gap-3 px-4 py-3"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(next) => {
                                    const shouldCheck = Boolean(next);
                                    setSelectedAccountIds((current) =>
                                      shouldCheck
                                        ? [...new Set([...current, branch.branch_id])]
                                        : current.filter((value) => value !== branch.branch_id)
                                    );
                                  }}
                                  className="mt-1"
                                />
                                <div className="space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-medium text-foreground">
                                      {branch.name}
                                      {branch.mask ? ` ••${branch.mask}` : ""}
                                    </p>
                                    <Badge className={branchBadgeClass(branch.status)}>
                                      {formatStatusLabel(branch.status)}
                                    </Badge>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {[branch.institution_name, branch.type, branch.subtype]
                                      .filter(Boolean)
                                      .join(" • ") || "Linked account"}
                                  </p>
                                </div>
                              </label>
                            );
                          })
                        )}
                      </SettingsGroup>
                    ) : null}

                    <PopupTextEditorField
                      title="Add a note"
                      description="Optional note the client will see with the request."
                      value={requestReason}
                      placeholder="Optional note for the client"
                      previewPlaceholder="Add an optional note for the client"
                      onSave={setRequestReason}
                      triggerClassName="min-h-[96px]"
                    />

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="blue-gradient"
                        effect="fill"
                        onClick={() => void handleRequestAccess()}
                        disabled={requestingAccess || availableScopeOptions.length === 0 || isTestProfile}
                      >
                        {requestingAccess ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Send request
                      </Button>
                      <Button asChild variant="none" effect="fade">
                        <Link href={consentManagerHref}>Open access</Link>
                      </Button>
                    </div>
                  </>
                )}
              </RiaSurface>
            </div>
          ) : null}

          {activeTab === "kai" ? (
            <div className="space-y-4" data-testid="ria-client-workspace-kai">
              {!workspace?.workspace_ready ? (
                <RiaSurface className="p-4 sm:p-5">
                  <p className="text-sm font-medium text-foreground">Portfolio is locked</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Approval is still pending, or the portfolio summary is still getting ready.
                  </p>
                </RiaSurface>
              ) : (
                <RiaSurface className="space-y-4 p-4 sm:p-5">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold tracking-tight text-foreground">Portfolio</p>
                    <p className="text-sm leading-6 text-muted-foreground">
                      A simple read that mirrors the client view.
                    </p>
                  </div>

                  {Object.keys(asRecord(financialSummary.asset_allocation_pct)).length > 0 ? (
                    <AllocationBar allocation={asRecord(financialSummary.asset_allocation_pct)} />
                  ) : null}

                  {summaryRows.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {summaryRows.map(([label, value]) => (
                        <div
                          key={label}
                          className="rounded-[var(--radius-md)] bg-[color:var(--app-card-surface-compact)] p-4 shadow-[var(--app-card-shadow-standard)]"
                        >
                          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
                          <p className="mt-2 text-lg font-semibold text-foreground">{String(value)}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm leading-6 text-muted-foreground">
                      The portfolio summary is not ready yet.
                    </p>
                  )}

                  <SettingsGroup embedded title="Visible accounts">
                    {activeAccountBranches
                      .filter((branch) => branch.status === "approved")
                      .map((branch) => (
                        <SettingsRow
                          key={branch.branch_id}
                          title={`${branch.name}${branch.mask ? ` ••${branch.mask}` : ""}`}
                          description={
                            [branch.institution_name, branch.type, branch.subtype]
                              .filter(Boolean)
                              .join(" • ") || "Linked account"
                          }
                        />
                      ))}
                  </SettingsGroup>
                </RiaSurface>
              )}
            </div>
          ) : null}

          {activeTab === "explorer" ? (
            <div className="space-y-4" data-testid="ria-client-workspace-explorer">
              {!workspace?.workspace_ready ? (
                <RiaSurface className="p-4 sm:p-5">
                  <p className="text-sm font-medium text-foreground">Data is locked</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Approval is still pending, or the client data is still getting ready.
                  </p>
                </RiaSurface>
              ) : (
                <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
                  <RiaSurface className="space-y-3 p-4 sm:p-5">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold tracking-tight text-foreground">Available data</p>
                      <p className="text-sm leading-6 text-muted-foreground">
                        The data groups that are ready to explore.
                      </p>
                    </div>
                    <SettingsGroup embedded>
                      {workspace.available_domains.length === 0 ? (
                        <div className="px-4 py-4 text-sm text-muted-foreground">
                          No indexed domains are ready yet.
                        </div>
                      ) : (
                        workspace.available_domains.map((domain) => (
                          <SettingsRow
                            key={domain}
                            title={formatDomainLabel(domain)}
                            description={explorerDomainSummary(domain, workspace.domain_summaries?.[domain])}
                            trailing={<span className="text-xs text-muted-foreground">{workspace.total_attributes}</span>}
                          />
                        ))
                      )}
                    </SettingsGroup>
                  </RiaSurface>

                  <RiaSurface className="space-y-3 p-4 sm:p-5">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold tracking-tight text-foreground">Accounts</p>
                      <p className="text-sm leading-6 text-muted-foreground">
                        Open an account for a cleaner detail view.
                      </p>
                    </div>
                    <SettingsGroup embedded>
                      {activeAccountBranches.length === 0 ? (
                        <div className="px-4 py-4 text-sm text-muted-foreground">
                          No linked accounts discovered yet.
                        </div>
                      ) : (
                        activeAccountBranches.map((branch) => (
                          <SettingsRow
                            key={branch.branch_id}
                            title={`${branch.name}${branch.mask ? ` ••${branch.mask}` : ""}`}
                            description={
                              [branch.institution_name, branch.type, branch.subtype]
                                .filter(Boolean)
                                .join(" • ") || "Linked account"
                            }
                            trailing={
                              <Badge className={branchBadgeClass(branch.status)}>
                                {formatStatusLabel(branch.status)}
                              </Badge>
                            }
                            onClick={() =>
                              router.push(
                                buildRiaClientAccountRoute(clientId, branch.branch_id, {
                                  testProfile: isTestProfile,
                                })
                              )
                            }
                            chevron
                          />
                        ))
                      )}
                    </SettingsGroup>
                  </RiaSurface>
                </div>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </RiaPageShell>
  );
}
