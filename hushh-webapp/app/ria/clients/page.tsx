"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BadgeCheck,
  ClipboardList,
  Copy,
  Loader2,
  MailPlus,
  ShieldCheck,
  Unplug,
  UserRound,
} from "lucide-react";

import { SectionHeader } from "@/components/app-ui/page-sections";
import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/profile/settings-ui";
import {
  RiaCompatibilityState,
  RiaPageShell,
  RiaStatusPanel,
  RiaSurface,
} from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { buildRiaConsentManagerHref } from "@/lib/consent/consent-sheet-route";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { buildRiaWorkspaceRoute, ROUTES } from "@/lib/navigation/routes";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { copyToClipboard } from "@/lib/utils/clipboard";
import {
  RiaService,
  type RiaAvailableScopeMetadata,
  type RiaClientAccess,
  type RiaClientDetail,
  type RiaClientListResponse,
  type RiaRequestScopeTemplate,
} from "@/lib/services/ria-service";

type SectionKey = "connected" | "pending" | "invites";
const CLIENTS_PAGE_SIZE = 24;

const SECTION_COPY: Record<
  SectionKey,
  { title: string; description: string; empty: string }
> = {
  connected: {
    title: "Connected",
    description: "Investors with an active relationship and a clear next step.",
    empty: "No connected investors yet.",
  },
  pending: {
    title: "Pending",
    description: "Relationships that need approval, a retry, or the next advisor action.",
    empty: "No pending relationships right now.",
  },
  invites: {
    title: "Invites",
    description: "Private links and unconverted outreach that still need investor action.",
    empty: "No open invites yet.",
  },
};

function buildInviteLink(inviteToken: string) {
  const invitePath = `/kai/onboarding?invite=${encodeURIComponent(inviteToken)}`;
  if (typeof window === "undefined") return invitePath;
  return `${window.location.origin}${invitePath}`;
}

function formatVerificationStatus(status?: string | null) {
  switch (status) {
    case "verified":
      return "IAPD verified";
    case "active":
      return "Active";
    case "bypassed":
      return "Bypassed";
    case "submitted":
      return "Submitted";
    case "rejected":
      return "Rejected";
    case "draft":
    default:
      return "Draft";
  }
}

function verificationTone(status?: string | null): "neutral" | "warning" | "success" | "critical" {
  switch (status) {
    case "active":
    case "verified":
    case "bypassed":
      return "success";
    case "submitted":
      return "warning";
    case "rejected":
      return "critical";
    case "draft":
    default:
      return "neutral";
  }
}

function formatStatusLabel(status?: string | null) {
  return String(status || "pending").replaceAll("_", " ");
}

function statusBadgeClass(status?: string | null) {
  switch (status) {
    case "approved":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "request_pending":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "invited":
      return "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "revoked":
    case "expired":
    case "blocked":
    case "disconnected":
      return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

function nextStepCopy(item: RiaClientAccess) {
  if (item.status === "approved") {
    return item.next_action || "Open the workspace or request additional access.";
  }
  if (item.status === "invited") {
    return item.next_action || "Share the invite and wait for the investor to join Kai.";
  }
  if (item.status === "request_pending") {
    return item.next_action || "The investor still needs to review the request bundle.";
  }
  if (item.status === "revoked" || item.status === "expired" || item.status === "disconnected") {
    return item.next_action || "Reconnect the relationship before requesting access again.";
  }
  return item.next_action || "Review the relationship and decide the next step.";
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
): Array<RiaAvailableScopeMetadata & { requested_by_template: boolean }> {
  if (!template) return [];
  const availableByScope = new Map(
    detail.available_scope_metadata.map((scope) => [scope.scope, scope])
  );
  return template.scopes
    .map((scope) => {
      const available = availableByScope.get(scope.scope);
      return {
        scope: scope.scope,
        label: available?.label || scope.label,
        description: available?.description || scope.description,
        kind: available?.kind || scope.kind,
        summary_only: available?.summary_only ?? scope.summary_only,
        available: Boolean(available),
        domain_key: available?.domain_key ?? null,
        requested_by_template: true,
      };
    })
    .filter((scope) => scope.available);
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

function picksFeedHelper(item: {
  picks_feed_status?: string | null;
  has_active_pick_upload?: boolean;
}) {
  if (item.picks_feed_status === "ready") {
    return "Investor can see the advisor's active feed in Kai.";
  }
  if (item.picks_feed_status === "pending") {
    return item.has_active_pick_upload
      ? "The relationship share is active."
      : "The share is active, but the advisor has not uploaded a current list yet.";
  }
  if (item.picks_feed_status === "included_on_approval") {
    return "This benefit is included automatically once the relationship is approved.";
  }
  return "Advisor picks are not currently available through this relationship.";
}

export default function RiaClientsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    riaCapability,
    riaOnboardingStatus,
    loading: personaLoading,
    refreshing: personaRefreshing,
  } = usePersonaState();
  const advisoryVerificationStatus =
    riaOnboardingStatus?.advisory_status || riaOnboardingStatus?.verification_status;

  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const deferredSearchQuery = useDeferredValue(searchQuery.trim());

  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [savingInvite, setSavingInvite] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteReason, setInviteReason] = useState("");
  const [lastCreatedInviteToken, setLastCreatedInviteToken] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<RiaClientAccess | null>(null);
  const [detail, setDetail] = useState<RiaClientDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [requestReason, setRequestReason] = useState("");
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const clientsResource = useStaleResource<RiaClientListResponse>({
    cacheKey: user?.uid
      ? `ria_clients_${user.uid}_${deferredSearchQuery}_all_${page}_${CLIENTS_PAGE_SIZE}`
      : "ria_clients_guest",
    enabled: Boolean(user?.uid && (riaCapability !== "setup" || personaRefreshing)),
    load: async () => {
      if (!user?.uid) {
        throw new Error("Sign in to access the client roster");
      }
      const idToken = await user.getIdToken();
      return RiaService.listClients(idToken, {
        userId: user.uid,
        q: deferredSearchQuery,
        page,
        limit: CLIENTS_PAGE_SIZE,
      });
    },
  });

  const items = useMemo(() => clientsResource.data?.items || [], [clientsResource.data?.items]);
  const totalItems = clientsResource.data?.total || 0;
  const hasMore = clientsResource.data?.has_more || false;
  const loading = clientsResource.loading;
  const refreshing = clientsResource.refreshing;
  const iamUnavailable = Boolean(clientsResource.error?.includes("IAM schema"));
  const rosterError = iamUnavailable ? null : clientsResource.error;

  async function copyInviteLink(inviteToken: string, marker: string) {
    try {
      const copied = await copyToClipboard(buildInviteLink(inviteToken));
      if (!copied) {
        throw new Error("clipboard_unavailable");
      }
      setCopiedInviteId(marker);
      window.setTimeout(() => {
        setCopiedInviteId((current) => (current === marker ? null : current));
      }, 1500);
      toast.success("Invite link copied");
    } catch {
      toast.error("Unable to copy the invite link from this browser session.");
    }
  }

  async function refreshClients(force = false) {
    setError(null);
    await clientsResource.refresh({ force });
  }

  async function loadClientDetail(investorUserId: string) {
    if (!user) return;
    try {
      setDetailLoading(true);
      setDetailError(null);
      const idToken = await user.getIdToken();
      const payload = await RiaService.getClientDetail(idToken, investorUserId, {
        userId: user.uid,
      });
      setDetail(payload);
      const nextTemplate = payload.requestable_scope_templates[0] || null;
      setSelectedTemplateId(nextTemplate?.template_id || "");
      setSelectedScopes(defaultScopesForTemplate(payload, nextTemplate));
    } catch (loadError) {
      setDetail(null);
      setDetailError(
        loadError instanceof Error ? loadError.message : "Failed to load relationship detail"
      );
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!personaLoading && !personaRefreshing && riaCapability === "setup") {
      router.replace(ROUTES.RIA_ONBOARDING);
    }
  }, [personaLoading, personaRefreshing, riaCapability, router]);

  const sortedItems = useMemo(
    () =>
      [...items].sort((left, right) => {
        const leftPriority =
          left.status === "approved" ? 0 : left.status === "request_pending" ? 1 : 2;
        const rightPriority =
          right.status === "approved" ? 0 : right.status === "request_pending" ? 1 : 2;
        return leftPriority - rightPriority;
      }),
    [items]
  );

  const connectedItems = sortedItems.filter((item) => item.status === "approved");
  const inviteItems = sortedItems.filter(
    (item) => item.status === "invited" || item.is_invite_only || Boolean(item.invite_token)
  );
  const pendingItems = sortedItems.filter(
    (item) => !connectedItems.includes(item) && !inviteItems.includes(item)
  );

  const sections: Array<{
    key: SectionKey;
    items: RiaClientAccess[];
  }> = [
    { key: "connected", items: connectedItems },
    { key: "pending", items: pendingItems },
    { key: "invites", items: inviteItems },
  ];

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

  async function openClientDetail(item: RiaClientAccess) {
    if (!item.investor_user_id) return;
    setSelectedClient(item);
    setDetailOpen(true);
    await loadClientDetail(item.investor_user_id);
  }

  async function handleCreateInvite() {
    if (!user) return;
    if (!inviteName && !inviteEmail && !invitePhone) {
      toast.error("Add a client name, email, or phone to create an invite.");
      return;
    }

    try {
      setSavingInvite(true);
      setError(null);
      const idToken = await user.getIdToken();
      const created = await RiaService.createInvites(idToken, {
        scope_template_id: "ria_financial_summary_v1",
        duration_mode: "preset",
        duration_hours: 168,
        reason: inviteReason.trim() || undefined,
        targets: [
          {
            display_name: inviteName || undefined,
            email: inviteEmail || undefined,
            phone: invitePhone || undefined,
            source: "manual",
            delivery_channel: inviteEmail ? "email" : invitePhone ? "sms" : "share_link",
          },
        ],
      });
      const invite = created.items[0];
      if (invite?.invite_token) {
        setLastCreatedInviteToken(invite.invite_token);
      }
      if (invite?.delivery_channel === "email" && invite.delivery_status === "sent") {
        toast.success("Invite email sent", {
          description:
            invite.delivery_message ||
            `Kai emailed ${invite.target_email || "the investor"} with the join link.`,
        });
      } else if (invite?.delivery_channel === "email" && invite.delivery_status === "failed") {
        toast.error("Invite created, but email delivery failed", {
          description:
            invite.delivery_message ||
            "The relationship exists, but the email did not go out. Copy the invite link instead.",
        });
      } else {
        toast.success("Invite created", {
          description: "The private Kai invite is ready to share.",
        });
      }
      setInviteName("");
      setInviteEmail("");
      setInvitePhone("");
      setInviteReason("");
      await refreshClients(true);
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Failed to create invite");
    } finally {
      setSavingInvite(false);
    }
  }

  async function handleDisconnect() {
    if (!user || !detail?.investor_user_id) return;

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
      await refreshClients(true);
      await loadClientDetail(detail.investor_user_id);
    } catch (disconnectError) {
      toast.error(
        disconnectError instanceof Error
          ? disconnectError.message
          : "Failed to disconnect relationship"
      );
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
      await refreshClients(true);
      await loadClientDetail(detail.investor_user_id);
    } catch (requestError) {
      toast.error(
        requestError instanceof Error
          ? requestError.message
          : "Failed to send the consent request"
      );
    } finally {
      setRequestingAccess(false);
    }
  }

  const consentManagerHref = buildRiaConsentManagerHref("pending", {
    from: ROUTES.RIA_CLIENTS,
  });

  return (
    <>
      <RiaPageShell
        eyebrow="Clients"
        title="Client roster"
        description="Scan connected, pending, and invited relationships first. Open the panel only when you need the full relationship detail."
        actions={
          <>
            <Button asChild variant="none" effect="fade">
              <Link href={consentManagerHref}>Consent manager</Link>
            </Button>
            <Button
              variant="blue-gradient"
              effect="fill"
              onClick={() => setInvitePanelOpen(true)}
            >
              <MailPlus className="mr-2 h-4 w-4" />
              New invite
            </Button>
          </>
        }
        statusPanel={
          iamUnavailable ? null : (
            <RiaStatusPanel
              title="Relationship readiness"
              description="Make the roster scannable before opening a relationship. Readiness, pending work, and invite drift stay visible here."
              dataTestId="ria-clients-primary"
              items={[
                {
                  label: "Verification",
                  value: formatVerificationStatus(advisoryVerificationStatus),
                  helper:
                    verificationTone(advisoryVerificationStatus) === "success"
                      ? "Requests and workspaces are enabled."
                      : "Trusted verification still gates advisor access.",
                  tone: verificationTone(advisoryVerificationStatus),
                },
                {
                  label: "Connected",
                  value: loading ? "..." : String(connectedItems.length),
                  helper: "Investors with active workspace access.",
                  tone: connectedItems.length > 0 ? "success" : "neutral",
                },
                {
                  label: "Pending",
                  value: loading ? "..." : String(pendingItems.length),
                  helper: "Relationships waiting on approval or a retry.",
                  tone: pendingItems.length > 0 ? "warning" : "neutral",
                },
                {
                  label: "Invites",
                  value: loading ? "..." : String(inviteItems.length),
                  helper: "Links still waiting to convert.",
                  tone: inviteItems.length > 0 ? "warning" : "neutral",
                },
              ]}
            />
          )
        }
      >
        {iamUnavailable ? (
          <RiaCompatibilityState
            title="RIA client management is waiting on IAM parity"
            description="The simplified roster is ready, but this environment still needs the IAM schema before invites, requests, and workspaces can operate end to end."
          />
        ) : null}

        {!iamUnavailable ? (
          <>
            <RiaSurface className="space-y-4 p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-semibold tracking-tight text-foreground">
                    Search, refresh, then select a relationship.
                  </p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    The roster stays calm on the surface. Invite creation, request bundles, and
                    disconnect flows only open when you select a client.
                  </p>
                </div>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => void refreshClients(true)}
                  disabled={refreshing}
                >
                  {refreshing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Refresh roster
                </Button>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Input
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search by name, email, or relationship state"
                  className="sm:max-w-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {totalItems > 0
                    ? `${totalItems} matching relationship${totalItems === 1 ? "" : "s"}`
                    : "Search stays warm from cache when available."}
                </p>
              </div>
              {error || rosterError ? (
                <p className="text-sm text-red-500">{error || rosterError}</p>
              ) : null}
            </RiaSurface>

            <div className="space-y-5" data-testid="ria-clients-roster">
              {sections.map((section) => {
              const sectionCopy = SECTION_COPY[section.key];
              return (
                <section
                  key={section.key}
                  className="space-y-3"
                  data-testid={`ria-clients-${section.key}`}
                >
                  <SectionHeader
                    eyebrow="Roster"
                    title={sectionCopy.title}
                    description={sectionCopy.description}
                    icon={
                      section.key === "connected"
                        ? ShieldCheck
                        : section.key === "pending"
                          ? ClipboardList
                          : MailPlus
                    }
                  />
                  <SettingsGroup>
                    {loading ? (
                      <div className="px-4 py-4 text-sm text-muted-foreground">
                        Loading {sectionCopy.title.toLowerCase()}...
                      </div>
                    ) : section.items.length === 0 ? (
                      <div className="px-4 py-4 text-sm text-muted-foreground">
                        {sectionCopy.empty}
                      </div>
                    ) : (
                      section.items.map((item) => {
                        const label =
                          item.investor_display_name ||
                          item.investor_user_id ||
                          item.invite_id ||
                          "Investor";

                        if (!item.investor_user_id) {
                          return (
                            <SettingsRow
                              key={item.id}
                              icon={MailPlus}
                              title={
                                <div className="flex flex-wrap items-center gap-2">
                                  <span>{label}</span>
                                  <Badge
                                    variant="outline"
                                    className={statusBadgeClass(item.status)}
                                  >
                                    {formatStatusLabel(item.status)}
                                  </Badge>
                                </div>
                              }
                              description={
                                [
                                  item.investor_email ||
                                    item.investor_secondary_label ||
                                    item.delivery_channel ||
                                    "share link",
                                  nextStepCopy(item),
                                ].join(" · ")
                              }
                              trailing={
                                item.invite_token ? (
                                  <Button
                                    variant="none"
                                    effect="fade"
                                    size="sm"
                                    onClick={() =>
                                      void copyInviteLink(item.invite_token || "", String(item.id))
                                    }
                                  >
                                    <Copy className="mr-2 h-4 w-4" />
                                    {copiedInviteId === String(item.id) ? "Copied" : "Copy invite"}
                                  </Button>
                                ) : (
                                  <span className="text-xs text-muted-foreground">Invite only</span>
                                )
                              }
                            />
                          );
                        }

                        return (
                          <SettingsRow
                            key={item.id}
                            icon={UserRound}
                            title={
                              <div className="flex flex-wrap items-center gap-2">
                                <span>{label}</span>
                                <Badge variant="outline" className={statusBadgeClass(item.status)}>
                                  {formatStatusLabel(item.status)}
                                </Badge>
                                {item.is_self_relationship ? (
                                  <Badge variant="secondary">Self</Badge>
                                ) : null}
                              </div>
                            }
                            description={
                              item.investor_email ||
                              item.investor_secondary_label ||
                              item.investor_headline ||
                              nextStepCopy(item)
                            }
                            trailing={
                              item.status === "approved" ? (
                                <span className="text-xs text-muted-foreground">
                                  Workspace ready
                                </span>
                              ) : item.invite_expires_at ? (
                                <span className="text-xs text-muted-foreground">
                                  Expires {formatDate(item.invite_expires_at) || "soon"}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {item.next_action || "Review"}
                                </span>
                              )
                            }
                            chevron
                            onClick={() => void openClientDetail(item)}
                          />
                        );
                      })
                    )}
                  </SettingsGroup>
                </section>
              );
              })}
            </div>
            <RiaSurface className="p-0">
              <PaginatedListFooter
                page={page}
                limit={CLIENTS_PAGE_SIZE}
                total={totalItems}
                hasMore={hasMore}
                onPrevious={() => setPage((current) => Math.max(1, current - 1))}
                onNext={() => setPage((current) => current + 1)}
              />
            </RiaSurface>
          </>
        ) : null}
      </RiaPageShell>

      <SettingsDetailPanel
        open={invitePanelOpen}
        onOpenChange={setInvitePanelOpen}
        title="Create a client invite"
        description="Invite first, then move into consent once the relationship exists."
      >
        <div className="space-y-5 px-4 pb-6 sm:px-5">
          <RiaSurface className="space-y-4 p-4">
            <Input
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
              placeholder="Investor name"
            />
            <Input
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="Investor email"
              type="email"
            />
            <Input
              value={invitePhone}
              onChange={(event) => setInvitePhone(event.target.value)}
              placeholder="Investor phone"
            />
            <Textarea
              value={inviteReason}
              onChange={(event) => setInviteReason(event.target.value)}
              placeholder="Optional context for the invite"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="blue-gradient"
                effect="fill"
                onClick={() => void handleCreateInvite()}
                disabled={savingInvite}
              >
                {savingInvite ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create invite
              </Button>
              <Button asChild variant="none" effect="fade">
                <a href="/templates/ria-picks-template.csv" download>
                  Download picks template
                </a>
              </Button>
            </div>
            {lastCreatedInviteToken ? (
              <div className="rounded-[20px] border border-primary/20 bg-primary/6 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/80">
                  Latest invite
                </p>
                <p className="mt-2 break-all text-sm text-foreground">
                  {buildInviteLink(lastCreatedInviteToken)}
                </p>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  className="mt-3"
                  onClick={() => void copyInviteLink(lastCreatedInviteToken, "latest")}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  {copiedInviteId === "latest" ? "Copied" : "Copy invite"}
                </Button>
              </div>
            ) : null}
          </RiaSurface>
        </div>
      </SettingsDetailPanel>

      <SettingsDetailPanel
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setSelectedClient(null);
            setDetail(null);
            setDetailError(null);
            setRequestReason("");
            setSelectedScopes([]);
            setSelectedTemplateId("");
          }
        }}
        title={
          detail?.investor_display_name ||
          selectedClient?.investor_display_name ||
          selectedClient?.investor_user_id ||
          "Relationship"
        }
        description={
          detail?.investor_headline ||
          "Review current access, available scope metadata, and the next relationship action."
        }
      >
        <div className="space-y-6 px-4 pb-6 sm:px-5">
          {detailLoading ? (
            <RiaSurface className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading relationship detail...
              </div>
            </RiaSurface>
          ) : null}

          {detailError ? (
            <RiaSurface tone="critical" className="p-4">
              <p className="text-sm text-red-500">{detailError}</p>
            </RiaSurface>
          ) : null}

          {detail ? (
            <>
              <RiaSurface className="space-y-4 p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className={statusBadgeClass(detail.relationship_status)}
                      >
                        {formatStatusLabel(detail.relationship_status)}
                      </Badge>
                      {detail.is_self_relationship ? (
                        <Badge variant="secondary">Self relationship</Badge>
                      ) : null}
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {detail.next_action || "Review the relationship and decide the next action."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detail.granted_scopes.length > 0 ? (
                      <Button asChild variant="blue-gradient" effect="fill" size="sm">
                        <Link href={buildRiaWorkspaceRoute(detail.investor_user_id)}>
                          Open workspace
                        </Link>
                      </Button>
                    ) : null}
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      onClick={() => void handleDisconnect()}
                      disabled={disconnecting || !detail.disconnect_allowed}
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

                <SettingsGroup embedded title="Relationship state">
                  <SettingsRow
                    title="Granted scopes"
                    description={
                      detail.consent_expires_at
                        ? `Access expires ${formatDate(detail.consent_expires_at)}`
                        : "No active expiry yet."
                    }
                    trailing={
                      <span className="text-xs text-muted-foreground">
                        {detail.granted_scopes.length} active
                      </span>
                    }
                  />
                  <SettingsRow
                    title="Metadata availability"
                    description={`${detail.available_domains.length} indexed domains across ${detail.total_attributes} tracked attributes.`}
                    trailing={
                      <span className="text-xs text-muted-foreground">
                        {detail.available_scope_metadata.length} visible
                      </span>
                    }
                  />
                  <SettingsRow
                    title="Advisor picks"
                    description={picksFeedHelper(detail)}
                    trailing={
                      <span className="text-xs text-muted-foreground">
                        {formatPicksFeedStatus(detail.picks_feed_status)}
                      </span>
                    }
                  />
                </SettingsGroup>
              </RiaSurface>

              {detail.is_self_relationship ? (
                <RiaSurface accent="sky" className="p-4">
                  <p className="text-sm text-foreground">
                    This is your dual-persona self relationship. You can use it to verify the full
                    RIA-to-investor flow before testing with a separate investor.
                  </p>
                </RiaSurface>
              ) : null}

              <section className="space-y-3">
                <SectionHeader
                  eyebrow="Request access"
                  title="Choose a template and request investor approval"
                  description="Scope choices stay grounded in the investor metadata that is actually available for this relationship."
                  icon={ClipboardList}
                />
                <RiaSurface className="space-y-4 p-4">
                  {detail.requestable_scope_templates.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Request templates will appear here once the RIA profile is trusted.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {detail.requestable_scope_templates.map((template) => (
                          <Button
                            key={template.template_id}
                            variant={
                              selectedTemplateId === template.template_id
                                ? "blue-gradient"
                                : "none"
                            }
                            effect={
                              selectedTemplateId === template.template_id ? "fill" : "fade"
                            }
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
                          No investor-specific scope metadata is available yet for the selected
                          template.
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
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-medium tracking-tight text-foreground">
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
                        placeholder="Optional context to include with this request"
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

              <section className="space-y-3">
                <SectionHeader
                  eyebrow="Visibility"
                  title="What this relationship can discover before the workspace opens"
                  description="This stays metadata-only until consent is active and the workspace route is available."
                  icon={BadgeCheck}
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
                        icon={scope.summary_only ? ClipboardList : ShieldCheck}
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

              <div className="grid gap-4 lg:grid-cols-2">
                <section className="space-y-3">
                  <SectionHeader
                    eyebrow="Granted"
                    title="Current access"
                    description="These scopes are readable right now."
                    icon={ShieldCheck}
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
                          icon={ShieldCheck}
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
                </section>

                <section className="space-y-3">
                  <SectionHeader
                    eyebrow="History"
                    title="Recent relationship activity"
                    description="Latest requests and invite events stay visible without a second dashboard."
                    icon={MailPlus}
                  />
                  <SettingsGroup>
                    {detail.request_history.length === 0 && detail.invite_history.length === 0 ? (
                      <div className="px-4 py-4 text-sm text-muted-foreground">
                        No relationship events yet.
                      </div>
                    ) : (
                      <>
                        {detail.request_history.slice(0, 3).map((request) => (
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
                        {detail.invite_history.slice(0, 2).map((invite) => (
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
                                <Button
                                  variant="none"
                                  effect="fade"
                                  size="sm"
                                  onClick={() =>
                                    void copyInviteLink(
                                      invite.invite_token,
                                      `detail-${invite.invite_id}`
                                    )
                                  }
                                >
                                  <Copy className="mr-2 h-4 w-4" />
                                  Copy
                                </Button>
                              ) : undefined
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
        </div>
      </SettingsDetailPanel>
    </>
  );
}
