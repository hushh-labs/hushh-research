"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ClipboardList,
  Loader2,
  MailPlus,
  Shield,
  Unplug,
  Waves,
} from "lucide-react";

import { PopupTextEditorField } from "@/components/app-ui/command-fields";
import { SectionHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import {
  RiaCompatibilityState,
  RiaPageShell,
  RiaStatusPanel,
  RiaSurface,
} from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { buildRiaConsentManagerHref } from "@/lib/consent/consent-sheet-route";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { buildRiaWorkspaceRoute, ROUTES } from "@/lib/navigation/routes";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
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

function RiaWorkspacePageContent() {
  const searchParams = useSearchParams();
  const clientId = useMemo(() => searchParams.get("clientId")?.trim() || "", [searchParams]);
  const { user } = useAuth();
  const cache = useMemo(() => CacheService.getInstance(), []);
  const detailCacheKey =
    user?.uid && clientId ? CACHE_KEYS.RIA_CLIENT_DETAIL(user.uid, clientId) : null;
  const workspaceCacheKey =
    user?.uid && clientId ? CACHE_KEYS.RIA_WORKSPACE(user.uid, clientId) : null;
  const cachedDetail = useMemo(
    () => (detailCacheKey ? cache.peek<RiaClientDetail>(detailCacheKey) : null),
    [cache, detailCacheKey]
  );
  const cachedWorkspace = useMemo(
    () => (workspaceCacheKey ? cache.peek<WorkspacePayload>(workspaceCacheKey) : null),
    [cache, workspaceCacheKey]
  );

  const [detail, setDetail] = useState<RiaClientDetail | null>(cachedDetail?.data ?? null);
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(cachedWorkspace?.data ?? null);
  const [loading, setLoading] = useState(!cachedDetail?.data && !cachedWorkspace?.data);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [iamUnavailable, setIamUnavailable] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [requestReason, setRequestReason] = useState("");
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    setDetail(cachedDetail?.data ?? null);
    setWorkspace(cachedWorkspace?.data ?? null);
  }, [
    cachedDetail?.data,
    cachedDetail?.timestamp,
    cachedWorkspace?.data,
    cachedWorkspace?.timestamp,
    clientId,
  ]);

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
        setLoading(!cachedDetail?.data && !cachedWorkspace?.data);
        setDetailError(null);
        setIamUnavailable(false);
        const idToken = await currentUser.getIdToken();
        const clientDetail = await RiaService.getClientDetail(idToken, clientId, {
          userId: currentUser.uid,
        });
        if (cancelled) return;
        setDetail(clientDetail);
        const defaultTemplate = clientDetail.requestable_scope_templates[0] || null;
        setSelectedTemplateId(defaultTemplate?.template_id || "");
        setSelectedScopes(defaultScopesForTemplate(clientDetail, defaultTemplate));

        if (clientDetail.granted_scopes.length > 0) {
          try {
            const workspacePayload = await RiaService.getWorkspace(idToken, clientId, {
              userId: currentUser.uid,
            });
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
  }, [cachedDetail?.data, cachedWorkspace?.data, clientId, user]);

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
  const consentManagerHref = buildRiaConsentManagerHref("pending", {
    from: buildRiaWorkspaceRoute(clientId),
  });

  async function refreshWorkspace() {
    if (!user || !clientId) return;
    try {
      setLoading(true);
      const idToken = await user.getIdToken();
      const [clientDetail, workspacePayload] = await Promise.all([
        RiaService.getClientDetail(idToken, clientId, { userId: user.uid }),
        RiaService.getWorkspace(idToken, clientId, { userId: user.uid }).catch(() => null),
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
        description: "Access ended immediately. History stays available if you reconnect.",
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
        description: "The investor can now review this bundle.",
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
        detail?.investor_email ||
        detail?.investor_secondary_label ||
        detail?.investor_headline ||
        "Consent-gated access stays grounded here: relationship state first, readable data second."
      }
      actions={
        <Button asChild variant="none" effect="fade">
          <Link href={ROUTES.RIA_CLIENTS}>Back to clients</Link>
        </Button>
      }
      statusPanel={
        iamUnavailable || !detail ? null : (
          <RiaStatusPanel
            title="Workspace state"
            description="This route should answer whether access is active before it tries to show any data detail."
            dataTestId="ria-workspace-primary"
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
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="none" effect="fade" size="sm">
                  <Link href={consentManagerHref}>Consent manager</Link>
                </Button>
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
            </div>

            {!workspace && detail.granted_scopes.length === 0 ? (
              <SettingsGroup embedded>
                <SettingsRow
                  icon={Shield}
                  title="This workspace is still metadata-only"
                  description="Relationship metadata is available, but the investor has not granted any active scopes yet. Request access below to move this relationship into a readable workspace."
                />
              </SettingsGroup>
            ) : null}
          </RiaSurface>

          <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
            <section className="space-y-3" data-testid="ria-workspace-access">
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

                    <PopupTextEditorField
                      title="Request bundle context"
                      description="Add optional context the investor should see alongside the requested scopes."
                      value={requestReason}
                      placeholder="Optional context for the investor"
                      previewPlaceholder="Add optional context for the investor"
                      onSave={setRequestReason}
                      triggerClassName="min-h-[96px]"
                    />

                    <div className="flex flex-wrap gap-2">
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
                      <Button asChild variant="none" effect="fade">
                        <Link href={consentManagerHref}>Open consent manager</Link>
                      </Button>
                    </div>
                  </>
                )}
              </RiaSurface>
            </section>

            <section className="space-y-3" data-testid="ria-workspace-data">
              <SectionHeader
                eyebrow="Data view"
                title="Workspace summary"
                description="Readable summaries appear only after consent is active."
                icon={Waves}
              />
              <RiaSurface className="space-y-4 p-4">
                {workspace ? (
                  <>
                    <SettingsGroup embedded>
                      <SettingsRow
                        title="Indexed domains"
                        description="Readable data domains currently available to this workspace."
                        trailing={
                          <span className="text-xs text-muted-foreground">
                            {workspace.available_domains.length}
                          </span>
                        }
                      />
                      <SettingsRow
                        title="Tracked attributes"
                        description="Attributes available across the granted domain set."
                        trailing={
                          <span className="text-xs text-muted-foreground">
                            {workspace.total_attributes}
                          </span>
                        }
                      />
                    </SettingsGroup>
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
                  <SettingsGroup embedded>
                    <SettingsRow
                      icon={Waves}
                      title="Readable data is not available yet"
                      description="The workspace summary appears after the investor approves an active scope bundle and the Personal Knowledge Model is indexed."
                    />
                    <SettingsRow
                      icon={Shield}
                      title="Metadata still helps"
                      description={`You can already review ${detail.available_scope_metadata.length} available metadata scope${detail.available_scope_metadata.length === 1 ? "" : "s"} before asking for access.`}
                    />
                  </SettingsGroup>
                )}
              </RiaSurface>
            </section>
          </div>

          <div className="grid gap-5 xl:grid-cols-2" data-testid="ria-workspace-secondary">
            <section className="space-y-3">
              <SectionHeader
                eyebrow="Metadata"
                title="Visible before consent"
                description="This stays metadata-only until the investor grants active scopes."
                icon={Shield}
              />
              <SettingsGroup>
                {detail.available_scope_metadata.length === 0 ? (
                  <div className="px-4 py-4 text-sm text-muted-foreground">
                    No investor-specific scope metadata is indexed yet.
                  </div>
                ) : (
                  detail.available_scope_metadata.map((scope) => (
                    <SettingsRow
                      key={scope.scope}
                      icon={scope.summary_only ? ClipboardList : Shield}
                      title={scope.label}
                      description={scope.description}
                      trailing={
                        <div className="flex items-center gap-2">
                          {scope.domain_key ? (
                            <Badge variant="outline" className="text-[10px] uppercase">
                              {scope.domain_key}
                            </Badge>
                          ) : null}
                          <Badge variant="secondary">
                            {scope.summary_only ? "Summary" : "Full model"}
                          </Badge>
                        </div>
                      }
                    />
                  ))
                )}
              </SettingsGroup>
            </section>

            <section className="space-y-3">
              <SectionHeader
                eyebrow="History"
                title="Recent relationship activity"
                description="Keep the latest request and invite events visible without another dashboard."
                icon={MailPlus}
              />
              <SettingsGroup>
                {detail.request_history.length === 0 && detail.invite_history.length === 0 ? (
                  <div className="px-4 py-4 text-sm text-muted-foreground">
                    No relationship events yet.
                  </div>
                ) : (
                  <>
                    {detail.request_history.slice(0, 4).map((request) => (
                      <SettingsRow
                        key={request.request_id || request.scope || request.action}
                        icon={ClipboardList}
                        title={request.scope_metadata?.label || request.scope || "Request"}
                        description={formatStatusLabel(request.action)}
                        trailing={
                          <span className="text-xs text-muted-foreground">
                            {formatDate(request.issued_at) || "Just now"}
                          </span>
                        }
                      />
                    ))}
                    {detail.invite_history.slice(0, 3).map((invite) => (
                      <SettingsRow
                        key={invite.invite_id}
                        icon={MailPlus}
                        title={
                          invite.target_display_name ||
                          invite.target_email ||
                          invite.target_phone ||
                          "Invite"
                        }
                        description={formatStatusLabel(invite.status)}
                        trailing={
                          invite.invite_token ? (
                            <Button asChild variant="none" effect="fade" size="sm">
                              <Link href={consentManagerHref}>Open</Link>
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {formatDate(invite.expires_at) || "In flight"}
                            </span>
                          )
                        }
                      />
                    ))}
                  </>
                )}
              </SettingsGroup>
            </section>
          </div>
        </>
      ) : null}
    </RiaPageShell>
  );
}

export default function RiaWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <RiaWorkspacePageContent />
    </Suspense>
  );
}
