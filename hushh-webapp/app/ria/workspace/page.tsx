"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ClipboardList, Loader2, Shield, Unplug, Waves } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/app-ui/page-sections";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import {
  RiaCompatibilityState,
  RiaPageShell,
  RiaStatusPanel,
  RiaSurface,
} from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import {
  isIAMSchemaNotReadyError,
  RiaService,
  type RiaAvailableScopeMetadata,
  type RiaClientDetail,
  type RiaRequestScopeTemplate,
} from "@/lib/services/ria-service";

type WorkspacePayload = Awaited<ReturnType<typeof RiaService.getWorkspace>>;

function formatStatusLabel(status?: string | null) {
  return String(status || "pending").replaceAll("_", " ");
}

function statusBadgeClass(status?: string | null) {
  switch (status) {
    case "approved":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "request_pending":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "revoked":
    case "expired":
    case "blocked":
    case "disconnected":
      return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

function formatDate(value?: string | number | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function formatPicksFeedStatus(status?: string | null) {
  switch (status) {
    case "ready":
      return "Shared";
    case "pending":
      return "Awaiting upload";
    case "included_on_approval":
      return "Included on approval";
    case "unavailable":
    default:
      return "Unavailable";
  }
}

function picksFeedHelper(value: {
  picks_feed_status?: string | null;
  has_active_pick_upload?: boolean;
}) {
  if (value.picks_feed_status === "ready") {
    return "The investor already has the advisor's active list in Kai.";
  }
  if (value.picks_feed_status === "pending") {
    return value.has_active_pick_upload
      ? "The picks share is active."
      : "The share is active, but there is no active advisor upload yet.";
  }
  if (value.picks_feed_status === "included_on_approval") {
    return "This benefit is included automatically when the relationship is approved.";
  }
  return "Advisor picks are not currently available for this relationship.";
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

export default function RiaWorkspacePage() {
  const searchParams = useSearchParams();
  const clientId = useMemo(() => searchParams.get("clientId")?.trim() || "", [searchParams]);
  const { user } = useAuth();

  const [detail, setDetail] = useState<RiaClientDetail | null>(null);
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [iamUnavailable, setIamUnavailable] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [requestReason, setRequestReason] = useState("");
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (!clientId) {
      setDetail(null);
      setWorkspace(null);
      setDetailError("Missing investor workspace identifier.");
      setLoading(false);
      return;
    }

    if (!user) {
      setLoading(false);
      return;
    }

    const currentUser = user;
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setDetailError(null);
        setIamUnavailable(false);
        const idToken = await currentUser.getIdToken();
        const clientDetail = await RiaService.getClientDetail(idToken, clientId);
        if (cancelled) return;
        setDetail(clientDetail);
        const defaultTemplate = clientDetail.requestable_scope_templates[0] || null;
        setSelectedTemplateId(defaultTemplate?.template_id || "");
        setSelectedScopes(defaultScopesForTemplate(clientDetail, defaultTemplate));

        if (clientDetail.granted_scopes.length > 0) {
          try {
            const workspacePayload = await RiaService.getWorkspace(idToken, clientId);
            if (!cancelled) {
              setWorkspace(workspacePayload);
            }
          } catch (workspaceError) {
            if (!cancelled) {
              setWorkspace(null);
              setDetailError(
                workspaceError instanceof Error
                  ? workspaceError.message
                  : "Failed to load workspace data"
              );
            }
          }
        } else if (!cancelled) {
          setWorkspace(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setDetail(null);
          setWorkspace(null);
          setIamUnavailable(isIAMSchemaNotReadyError(loadError));
          setDetailError(
            loadError instanceof Error ? loadError.message : "Failed to load workspace"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [clientId, user]);

  const activeTemplate =
    detail?.requestable_scope_templates.find(
      (template) => template.template_id === selectedTemplateId
    ) ||
    detail?.requestable_scope_templates[0] ||
    null;

  const availableScopeOptions = useMemo(
    () => (detail ? visibleScopesForTemplate(detail, activeTemplate) : []),
    [activeTemplate, detail]
  );

  async function refreshWorkspace() {
    if (!user || !clientId) return;
    try {
      setLoading(true);
      const idToken = await user.getIdToken();
      const [clientDetail, workspacePayload] = await Promise.all([
        RiaService.getClientDetail(idToken, clientId),
        RiaService.getWorkspace(idToken, clientId).catch(() => null),
      ]);
      setDetail(clientDetail);
      setWorkspace(workspacePayload);
      const defaultTemplate =
        clientDetail.requestable_scope_templates.find(
          (template) => template.template_id === selectedTemplateId
        ) ||
        clientDetail.requestable_scope_templates[0] ||
        null;
      setSelectedTemplateId(defaultTemplate?.template_id || "");
      setSelectedScopes(defaultScopesForTemplate(clientDetail, defaultTemplate));
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Failed to refresh workspace");
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    if (!user || !detail) return;
    try {
      setDisconnecting(true);
      const idToken = await user.getIdToken();
      await ConsentCenterService.disconnectRelationship({
        idToken,
        investor_user_id: detail.investor_user_id,
      });
      toast.success("Relationship disconnected", {
        description:
          "Advisor access was revoked immediately. You can reconnect later without losing history.",
      });
      await refreshWorkspace();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to disconnect relationship");
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleRequestAccess() {
    if (!user || !detail || !activeTemplate) return;
    if (selectedScopes.length === 0) {
      toast.error("Select at least one scope to request.");
      return;
    }

    try {
      setRequestingAccess(true);
      const idToken = await user.getIdToken();
      await RiaService.createRequestBundle(idToken, {
        subject_user_id: detail.investor_user_id,
        scope_template_id: activeTemplate.template_id,
        selected_scopes: selectedScopes,
        reason: requestReason.trim() || undefined,
      });
      toast.success("Consent request sent", {
        description: "The investor can now review this bundle from the shared consent workspace.",
      });
      setRequestReason("");
      await refreshWorkspace();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send request bundle");
    } finally {
      setRequestingAccess(false);
    }
  }

  return (
    <RiaPageShell
      eyebrow="Workspace"
      title={detail?.investor_display_name || "Investor workspace"}
      description={
        detail?.investor_headline ||
        "Consent-gated access stays grounded here: relationship state first, readable data second."
      }
      actions={
        <>
          <Button asChild variant="none" effect="fade">
            <Link href={ROUTES.RIA_CLIENTS}>Back to clients</Link>
          </Button>
          <Button asChild variant="blue-gradient" effect="fill">
            <Link href={ROUTES.CONSENTS}>Open consents</Link>
          </Button>
        </>
      }
      statusPanel={
        iamUnavailable || !detail ? null : (
          <RiaStatusPanel
            title="Workspace state"
            description="This route should answer whether access is active before it tries to show any data detail."
            items={[
              {
                label: "Relationship",
                value: formatStatusLabel(detail.relationship_status),
                helper: detail.next_action || "Relationship lifecycle state",
                tone: detail.relationship_status === "approved" ? "success" : "warning",
              },
              {
                label: "Granted scopes",
                value: String(detail.granted_scopes.length),
                helper: "Scopes readable right now",
                tone: detail.granted_scopes.length > 0 ? "success" : "warning",
              },
              {
                label: "Workspace",
                value: workspace?.workspace_ready || detail.workspace_ready ? "Ready" : "Locked",
                helper:
                  workspace?.workspace_ready || detail.workspace_ready
                    ? "Data view is available"
                    : "Consent or indexing is still incomplete",
                tone:
                  workspace?.workspace_ready || detail.workspace_ready ? "success" : "warning",
              },
              {
                label: "Advisor picks",
                value: formatPicksFeedStatus(
                  workspace?.picks_feed_status || detail.picks_feed_status
                ),
                helper: picksFeedHelper({
                  picks_feed_status: workspace?.picks_feed_status || detail.picks_feed_status,
                  has_active_pick_upload:
                    workspace?.has_active_pick_upload || detail.has_active_pick_upload,
                }),
                tone:
                  (workspace?.picks_feed_status || detail.picks_feed_status) === "ready"
                    ? "success"
                    : (workspace?.picks_feed_status || detail.picks_feed_status) === "pending"
                      ? "warning"
                      : "neutral",
              },
              {
                label: "Consent expires",
                value: formatDate(detail.consent_expires_at) || "Not granted",
                helper: "Latest active grant window",
                tone: detail.consent_expires_at ? "neutral" : "warning",
              },
            ]}
          />
        )
      }
    >
      {iamUnavailable ? (
        <RiaCompatibilityState
          title="Workspace access is unavailable in this environment"
          description="The route is wired correctly, but this environment still needs the full IAM schema before workspaces can read investor data."
        />
      ) : null}

      {loading ? (
        <RiaSurface className="p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading workspace...
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
          <RiaSurface className="space-y-4 p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusBadgeClass(detail.relationship_status)}>
                    {formatStatusLabel(detail.relationship_status)}
                  </Badge>
                  {detail.is_self_relationship ? (
                    <Badge variant="secondary">Self relationship</Badge>
                  ) : null}
                </div>
                <p className="text-sm leading-6 text-muted-foreground">
                  {detail.next_action || "Review the relationship before asking for more data."}
                </p>
                <p className="text-xs text-muted-foreground">
                  {picksFeedHelper({
                    picks_feed_status: workspace?.picks_feed_status || detail.picks_feed_status,
                    has_active_pick_upload:
                      workspace?.has_active_pick_upload || detail.has_active_pick_upload,
                  })}
                </p>
              </div>
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => void handleDisconnect()}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Unplug className="mr-2 h-4 w-4" />
                )}
                Disconnect
              </Button>
            </div>

            {!workspace && detail.granted_scopes.length === 0 ? (
              <SurfaceInset className="border-primary/20 bg-primary/6 p-4">
                <p className="text-sm font-medium text-foreground">
                  This workspace is still locked.
                </p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Relationship metadata is available, but the investor has not granted any active
                  scopes yet. Request access below to move this relationship into a readable
                  workspace.
                </p>
              </SurfaceInset>
            ) : null}
          </RiaSurface>

          <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
            <section className="space-y-3">
              <SectionHeader
                eyebrow="Access"
                title="Granted scopes"
                description="These scopes define what the workspace is allowed to read right now."
                icon={Shield}
              />
              <SettingsGroup>
                {detail.granted_scopes.length === 0 ? (
                  <div className="px-4 py-4 text-sm text-muted-foreground">
                    No active scopes yet.
                  </div>
                ) : (
                  detail.granted_scopes.map((scope) => (
                    <SettingsRow
                      key={scope.scope}
                      icon={Shield}
                      title={scope.label}
                      description={scope.scope}
                      trailing={
                        <span className="text-xs text-muted-foreground">
                          {formatDate(scope.expires_at) || "No expiry"}
                        </span>
                      }
                    />
                  ))
                )}
              </SettingsGroup>

              <SectionHeader
                eyebrow="Request more"
                title="Ask for additional access"
                description="Only metadata-level scope options are shown here until the investor approves them."
                icon={ClipboardList}
              />
              <RiaSurface className="space-y-4 p-4">
                {detail.requestable_scope_templates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Request templates are unavailable until the RIA profile is trusted.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {detail.requestable_scope_templates.map((template) => (
                        <Button
                          key={template.template_id}
                          variant={
                            selectedTemplateId === template.template_id ? "blue-gradient" : "none"
                          }
                          effect={selectedTemplateId === template.template_id ? "fill" : "fade"}
                          size="sm"
                          onClick={() => {
                            setSelectedTemplateId(template.template_id);
                            setSelectedScopes(defaultScopesForTemplate(detail, template));
                          }}
                        >
                          {template.template_name}
                        </Button>
                      ))}
                    </div>

                    {availableScopeOptions.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No additional investor-specific scope metadata is available for the selected
                        template yet.
                      </p>
                    ) : (
                      <div className="space-y-3">
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
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-medium text-foreground">
                                    {scope.label}
                                  </p>
                                  <Badge variant="outline" className="text-[10px] uppercase">
                                    {scope.kind.replaceAll("_", " ")}
                                  </Badge>
                                  {scope.summary_only ? (
                                    <Badge variant="secondary">Summary</Badge>
                                  ) : null}
                                </div>
                                <p className="text-xs leading-5 text-muted-foreground">
                                  {scope.description}
                                </p>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}

                    <Textarea
                      value={requestReason}
                      onChange={(event) => setRequestReason(event.target.value)}
                      placeholder="Optional context for the investor"
                    />

                    <Button
                      variant="blue-gradient"
                      effect="fill"
                      onClick={() => void handleRequestAccess()}
                      disabled={requestingAccess || availableScopeOptions.length === 0}
                    >
                      {requestingAccess ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Send request bundle
                    </Button>
                  </>
                )}
              </RiaSurface>
            </section>

            <section className="space-y-3">
              <SectionHeader
                eyebrow="Data view"
                title="Workspace summary"
                description="Readable summaries appear only after consent is active."
                icon={Waves}
              />
              <RiaSurface className="space-y-4 p-4">
                {workspace ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-[20px] border border-border/60 bg-background/70 p-4">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                          Domains
                        </p>
                        <p className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                          {workspace.available_domains.length}
                        </p>
                      </div>
                      <div className="rounded-[20px] border border-border/60 bg-background/70 p-4">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                          Attributes
                        </p>
                        <p className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                          {workspace.total_attributes}
                        </p>
                      </div>
                    </div>
                    <SettingsGroup>
                      {workspace.available_domains.length === 0 ? (
                        <div className="px-4 py-4 text-sm text-muted-foreground">
                          No indexed domains are ready yet.
                        </div>
                      ) : (
                        workspace.available_domains.map((domain) => (
                          <SettingsRow
                            key={domain}
                            icon={Waves}
                            title={domain}
                            description={
                              workspace.domain_summaries?.[domain]
                                ? JSON.stringify(workspace.domain_summaries[domain])
                                : "Summary unavailable"
                            }
                          />
                        ))
                      )}
                    </SettingsGroup>
                  </>
                ) : (
                  <p className="text-sm leading-6 text-muted-foreground">
                    The readable workspace summary will appear here after the investor approves an
                    active scope bundle and the Personal Knowledge Model is indexed.
                  </p>
                )}
              </RiaSurface>
            </section>
          </div>
        </>
      ) : null}
    </RiaPageShell>
  );
}
