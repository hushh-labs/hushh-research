"use client";

import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUpRight, BriefcaseBusiness, Building2, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { useConsentActions, type PendingConsent } from "@/lib/consent";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import { usePersonaState } from "@/lib/persona/persona-context";
import { Button } from "@/lib/morphy-ux/button";
import {
  ROUTES,
  buildMarketplaceConnectionPortfolioRoute,
} from "@/lib/navigation/routes";
import {
  ConnectionCenterService,
  type ConnectionSurface,
} from "@/lib/services/connection-center-service";
import {
  type ConsentCenterActor,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  RiaService,
  type RiaClientDetail,
  type RiaRequestScopeTemplate,
} from "@/lib/services/ria-service";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";

type RiaConnectionWorkspace = Awaited<ReturnType<typeof RiaService.getWorkspace>>;

function normalizeTab(value: string | null): ConnectionSurface {
  if (value === "active" || value === "previous") return value;
  return "pending";
}

function formatStatus(status?: string | null) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "active") return "Connected";
  if (normalized === "request_pending") return "Pending";
  if (normalized === "discovered") return "Not yet connected";
  if (normalized === "revoked") return "Ended";
  return normalized.replaceAll("_", " ") || "pending";
}

function formatDate(value?: string | number | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function badgeClassName(status?: string | null) {
  switch (String(status || "").toLowerCase()) {
    case "active":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "request_pending":
    case "pending":
    case "invited":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "discovered":
    case "denied":
    case "revoked":
    case "disconnected":
    case "expired":
      return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

function toPendingConsent(entry: ConsentCenterEntry): PendingConsent {
  const issuedAt = typeof entry.issued_at === "number" ? entry.issued_at : Date.now();
  const approvalTimeoutAt =
    typeof entry.approval_timeout_at === "number"
      ? entry.approval_timeout_at
      : entry.expires_at && typeof entry.expires_at === "number"
        ? entry.expires_at
        : undefined;

  return {
    id: entry.request_id || entry.id,
    developer: entry.counterpart_label || entry.counterpart_email || "Connection",
    developerImageUrl: entry.counterpart_image_url || undefined,
    developerWebsiteUrl: entry.counterpart_website_url || undefined,
    scope: entry.scope || "",
    scopeDescription: entry.scope_description || undefined,
    requestedAt: issuedAt,
    approvalTimeoutAt,
    requestUrl: entry.request_url || undefined,
    reason: entry.reason || undefined,
    metadata: entry.metadata || undefined,
  };
}

function canReviewPending(actor: ConsentCenterActor, entry: ConsentCenterEntry | null) {
  if (!entry) return false;
  if (String(entry.status || "").toLowerCase() !== "request_pending") return false;
  const scope = String(entry.scope || "").toLowerCase();
  if (actor === "ria") return scope.startsWith("attr.ria.");
  return !scope.startsWith("attr.ria.");
}

function hasPortfolioScope(scopes: Array<{ scope: string }> | undefined) {
  return (scopes || []).some((item) => {
    const scope = String(item.scope || "");
    return scope.startsWith("attr.financial.") || scope === "pkm.read";
  });
}

type PortfolioAccessOption = {
  id: string;
  label: string;
  description: string;
  scopes: string[];
  templateId: string;
};

function portfolioRequestOptions(detail: RiaClientDetail | null): PortfolioAccessOption[] {
  const templates = detail?.requestable_scope_templates || [];
  if (templates.length === 0) return [];

  const options: PortfolioAccessOption[] = [];

  for (const template of templates) {
    const scopeEntries = template.scopes || [];
    if (scopeEntries.length === 0) continue;

    const allScopes = scopeEntries.map((item) => String(item.scope || "").trim()).filter(Boolean);
    const summaryScopes = scopeEntries
      .filter((item) => item.summary_only)
      .map((item) => String(item.scope || "").trim())
      .filter(Boolean);
    const fullScopes = allScopes.filter((scope) => !summaryScopes.includes(scope));

    if (summaryScopes.length > 0) {
      options.push({
        id: `${template.template_id}:summary`,
        label: template.template_name || "Overview access",
        description: template.description || scopeEntries.map((s) => s.label).filter(Boolean).join(", ") || "Summary-level access to shared data.",
        scopes: summaryScopes,
        templateId: template.template_id,
      });
    }

    if (fullScopes.length > 0 && fullScopes.length !== allScopes.length) {
      options.push({
        id: `${template.template_id}:full`,
        label: `Full ${(template.template_name || "access").toLowerCase()}`,
        description: `All scopes including ${scopeEntries.filter((s) => !s.summary_only).map((s) => s.label).filter(Boolean).join(", ") || "deeper workspace access"}.`,
        scopes: allScopes,
        templateId: template.template_id,
      });
    }

    if (summaryScopes.length === 0 && fullScopes.length === allScopes.length) {
      options.push({
        id: template.template_id,
        label: template.template_name || "Request access",
        description: template.description || scopeEntries.map((s) => s.label).filter(Boolean).join(", ") || "Shared data access.",
        scopes: allScopes,
        templateId: template.template_id,
      });
    }
  }

  if (options.length === 0) {
    const fallbackTemplate = templates.find((t) => t.template_id === "ria_financial_summary_v1");
    if (fallbackTemplate) {
      const available = new Set((fallbackTemplate.scopes || []).map((s) => String(s.scope || "").trim()));
      if (available.has("attr.financial.*")) {
        options.push({
          id: "overview",
          label: "Portfolio overview",
          description: "Summary, allocation, and core portfolio profile.",
          scopes: ["attr.financial.*"],
          templateId: fallbackTemplate.template_id,
        });
      }
      if (available.has("attr.financial.*") && available.has("pkm.read")) {
        options.push({
          id: "full",
          label: "Full shared portfolio access",
          description: "Overview plus deeper Kai workspace context for this connection.",
          scopes: ["attr.financial.*", "pkm.read"],
          templateId: fallbackTemplate.template_id,
        });
      }
    }
  }

  return options;
}

function CounterpartAvatar({ entry }: { entry: ConsentCenterEntry }) {
  const kind = entry.counterpart_type === "ria" ? "ria" : "investor";
  const Icon = kind === "ria" ? Building2 : UserRound;
  const label = entry.counterpart_label || entry.counterpart_id || "";
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
  return (
    <div
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border",
        kind === "ria"
          ? "border-sky-500/15 bg-sky-500/6 text-sky-700"
          : "border-emerald-500/15 bg-emerald-500/6 text-emerald-700"
      )}
    >
      {initials ? (
        <span className="text-xs font-semibold">{initials}</span>
      ) : (
        <Icon className="h-4 w-4" />
      )}
    </div>
  );
}

function connectionScopeSummary(entry: ConsentCenterEntry) {
  if (entry.additional_access_summary) return entry.additional_access_summary;
  if (entry.scope_description) return entry.scope_description;
  if (entry.reason) return entry.reason;
  return "Connection";
}

const ConnectionRow = React.memo(function ConnectionRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ConsentCenterEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative w-full overflow-hidden rounded-[var(--radius-md)] border px-4 py-3 text-left transition-colors",
        selected
          ? "border-sky-500/30 bg-sky-500/6"
          : "border-transparent bg-transparent hover:border-border/60 hover:bg-muted/35"
      )}
    >
      <div className="flex items-start gap-3">
        <CounterpartAvatar entry={entry} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-semibold text-foreground">
              {entry.counterpart_label || entry.counterpart_id || "Connection"}
            </p>
            <Badge className={cn("shrink-0 capitalize", badgeClassName(entry.status))}>
              {formatStatus(entry.status)}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {entry.counterpart_secondary_label || entry.counterpart_email || "Hushh connection"}
          </p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 text-sm leading-6 text-foreground/80">
        {connectionScopeSummary(entry)}
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {entry.scope_description ? <span>{entry.scope_description}</span> : null}
        {entry.issued_at ? <span>{formatDate(entry.issued_at)}</span> : null}
      </div>
      <MaterialRipple variant="none" effect="fade" className="z-0" />
    </button>
  );
});

export default function MarketplaceConnectionsPageClient({
  initialSearchParams,
  initialSelectedId,
}: {
  initialSearchParams: string;
  initialSelectedId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useMemo(
    () => new URLSearchParams(initialSearchParams),
    [initialSearchParams]
  );
  const { user } = useAuth();
  const { getVaultOwnerToken, isVaultUnlocked } = useVault();
  const { activePersona } = usePersonaState();
  const actor: ConsentCenterActor = activePersona === "ria" ? "ria" : "investor";
  const tab = normalizeTab(searchParams.get("tab"));
  const page = Math.max(1, Number(searchParams.get("page") || "1") || 1);
  const selectedId = initialSelectedId || searchParams.get("selected");
  const [searchValue, setSearchValue] = useState(searchParams.get("q") || "");
  const deferredQuery = useDeferredValue(searchValue.trim());
  const [summary, setSummary] = useState<{ pending: number; active: number; previous: number } | null>(
    null
  );
  const [listState, setListState] = useState<{
    loading: boolean;
    total: number;
    hasMore: boolean;
    items: ConsentCenterEntry[];
  }>({
    loading: true,
    total: 0,
    hasMore: false,
    items: [],
  });
  const [mutationTick, setMutationTick] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [riaDetail, setRiaDetail] = useState<RiaClientDetail | null>(null);
  const [riaWorkspace, setRiaWorkspace] = useState<RiaConnectionWorkspace | null>(null);
  const [requestingAccessId, setRequestingAccessId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false);
  const [confirmDeclineOpen, setConfirmDeclineOpen] = useState(false);
  const acknowledgedRequestKeysRef = useRef(new Set<string>());

  const selectedEntry = useMemo(() => {
    if (listState.items.length === 0 || !selectedId) return null;
    return (
      listState.items.find(
        (item) => item.counterpart_id === selectedId || item.request_id === selectedId || item.id === selectedId
      ) || null
    );
  }, [listState.items, selectedId]);

  const { handleApprove, handleDeny } = useConsentActions({
    userId: user?.uid,
    onActionComplete: () => setMutationTick((value) => value + 1),
  });

  const setParam = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  useEffect(() => {
    const current = searchParams.get("q") || "";
    if (current !== searchValue) {
      setSearchValue(current);
    }
  }, [searchParams, searchValue]);

  useEffect(() => {
    const handleMutation = () => setMutationTick((value) => value + 1);
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleMutation);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleMutation);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleMutation);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, handleMutation);
    };
  }, []);

  useEffect(() => {
    if (!user || !isVaultUnlocked || tab !== "pending" || !selectedEntry) return;
    if (!canReviewPending(actor, selectedEntry)) return;

    const requestId = String(selectedEntry.request_id || selectedEntry.id || "").trim();
    if (!requestId) return;

    const metadata =
      selectedEntry.metadata && typeof selectedEntry.metadata === "object"
        ? (selectedEntry.metadata as Record<string, unknown>)
        : {};
    const bundleId = String(metadata.bundle_id || "").trim() || undefined;
    const ackKey = `${bundleId || "request"}:${requestId}`;
    if (acknowledgedRequestKeysRef.current.has(ackKey)) return;

    const vaultOwnerToken = getVaultOwnerToken();
    if (!vaultOwnerToken) return;

    acknowledgedRequestKeysRef.current.add(ackKey);
    void ApiService.markPendingConsentOpened({
      userId: user.uid,
      vaultOwnerToken,
      requestId,
      bundleId,
      openedVia: "connection_route",
    }).catch((error) => {
      acknowledgedRequestKeysRef.current.delete(ackKey);
      console.warn("[MarketplaceConnections] Failed to acknowledge pending request:", error);
    });
  }, [actor, getVaultOwnerToken, isVaultUnlocked, selectedEntry, tab, user]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!user) return;
      try {
        const idToken = await user.getIdToken();
        const [nextSummary, nextList] = await Promise.all([
          ConnectionCenterService.getSummary({
            idToken,
            userId: user.uid,
            actor,
            force: mutationTick > 0,
          }),
          ConnectionCenterService.listConnections({
            idToken,
            userId: user.uid,
            actor,
            surface: tab,
            q: deferredQuery,
            page,
            force: mutationTick > 0,
          }),
        ]);
        if (cancelled) return;
        setSummary(nextSummary.counts);
        setListState({
          loading: false,
          total: nextList.total,
          hasMore: nextList.has_more,
          items: nextList.items || [],
        });
      } catch (error) {
        if (cancelled) return;
        setSummary({ pending: 0, active: 0, previous: 0 });
        setListState({ loading: false, total: 0, hasMore: false, items: [] });
        toast.error(error instanceof Error ? error.message : "Failed to load connections");
      }
    }

    setListState((current) => ({ ...current, loading: true }));
    void load();
    return () => {
      cancelled = true;
    };
  }, [actor, deferredQuery, mutationTick, page, tab, user]);

  useEffect(() => {
    let cancelled = false;
    async function loadDetail() {
      if (!user || actor !== "ria" || !selectedEntry?.counterpart_id) {
        setRiaDetail(null);
        setRiaWorkspace(null);
        setDetailLoading(false);
        return;
      }
      try {
        setDetailLoading(true);
        const idToken = await user.getIdToken();
        const [detailPayload, workspacePayload] = await Promise.all([
          ConnectionCenterService.getRiaConnectionDetail({
            idToken,
            userId: user.uid,
            investorUserId: selectedEntry.counterpart_id,
            force: mutationTick > 0,
          }),
          ConnectionCenterService.getRiaConnectionWorkspace({
            idToken,
            userId: user.uid,
            investorUserId: selectedEntry.counterpart_id,
            force: mutationTick > 0,
          }).catch(() => null),
        ]);
        if (cancelled) return;
        setRiaDetail(detailPayload);
        setRiaWorkspace(workspacePayload);
      } catch {
        if (cancelled) return;
        setRiaDetail(null);
        setRiaWorkspace(null);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [actor, mutationTick, selectedEntry?.counterpart_id, user]);

  async function handleRequestAccess(template: RiaRequestScopeTemplate, selectedScopes: string[]) {
    if (!user || !selectedEntry?.counterpart_id) return;
    try {
      setRequestingAccessId(selectedEntry.counterpart_id);
      const idToken = await user.getIdToken();
      await ConnectionCenterService.requestRiaPortfolioAccess({
        idToken,
        subjectUserId: selectedEntry.counterpart_id,
        scopeTemplateId: template.template_id,
        selectedScopes,
        reason: "Kai portfolio access request",
      });
      toast.success("Access request sent", {
        description: "The investor can review it in Consent manager.",
      });
      setMutationTick((value) => value + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send access request");
    } finally {
      setRequestingAccessId(null);
    }
  }

  async function handleDisconnect() {
    if (!user || !selectedEntry) return;
    try {
      setDisconnectingId(selectedEntry.id);
      const idToken = await user.getIdToken();
      const metadata =
        selectedEntry.metadata && typeof selectedEntry.metadata === "object"
          ? (selectedEntry.metadata as Record<string, unknown>)
          : {};
      await ConnectionCenterService.disconnect({
        idToken,
        investorUserId:
          actor === "ria"
            ? selectedEntry.counterpart_id || undefined
            : (metadata.investor_user_id as string | undefined),
        riaProfileId:
          actor === "investor" ? (metadata.ria_profile_id as string | undefined) : undefined,
      });
      toast.success("Connection ended");
      setMutationTick((value) => value + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to end connection");
    } finally {
      setDisconnectingId(null);
    }
  }

  const detailOptions = portfolioRequestOptions(riaDetail);
  const detailTemplateMap = useMemo(() => {
    const map = new Map<string, RiaRequestScopeTemplate>();
    for (const template of riaDetail?.requestable_scope_templates || []) {
      map.set(template.template_id, template);
    }
    return map;
  }, [riaDetail?.requestable_scope_templates]);
  const canOpenPortfolio =
    actor === "ria" &&
    Boolean(selectedEntry?.counterpart_id) &&
    (hasPortfolioScope(riaDetail?.granted_scopes) || hasPortfolioScope(riaWorkspace?.granted_scopes));

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="pb-28"
      nativeTest={{
        routeId: "/marketplace/connections",
        marker: "native-route-marketplace-connections",
        authState: user ? "authenticated" : "pending",
        dataState: listState.loading
          ? "loading"
          : (summary?.active ?? 0) > 0 || (summary?.pending ?? 0) > 0
            ? "loaded"
            : "empty-valid",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Connect"
          title={actor === "ria" ? "Investor connections" : "Advisor connections"}
          description="Manage pending requests, active connections, and past decisions here. Consent manager now stays focused on actual access requests."
          icon={BriefcaseBusiness}
          accent="marketplace"
          actions={
            <div className="flex items-center gap-2">
              <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                {summary?.pending ?? 0} pending
              </Badge>
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => router.push(ROUTES.MARKETPLACE)}
              >
                Explore
              </Button>
            </div>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <section className="space-y-4">
          <SettingsSegmentedTabs
            value={tab}
            onValueChange={(value) => setParam({ tab: value, page: "1", selected: null })}
            options={[
              { value: "pending", label: `Pending (${summary?.pending ?? 0})` },
              { value: "active", label: `Active (${summary?.active ?? 0})` },
              { value: "previous", label: `Previous (${summary?.previous ?? 0})` },
            ]}
          />

          <SettingsGroup embedded>
            <div className="px-4 py-4">
              <Input
                value={searchValue}
                onChange={(event) => {
                  const next = event.target.value;
                  setSearchValue(next);
                  setParam({ q: next || null, page: "1" });
                }}
                placeholder={`Search ${tab} connections`}
              />
            </div>
          </SettingsGroup>

          <SettingsGroup embedded>
            <div className="grid gap-2 px-2 py-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {listState.loading && listState.items.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading connections...
                </div>
              ) : null}
              {!listState.loading && listState.items.length === 0 ? (
                <div className="space-y-3 px-3 py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {tab === "pending"
                      ? "No pending connections right now."
                      : tab === "active"
                        ? "No active connections yet."
                        : "No previous connections. Your history will appear here."}
                  </p>
                  {tab !== "previous" ? (
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      onClick={() => router.push(ROUTES.MARKETPLACE)}
                    >
                      Browse the marketplace
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {listState.items.map((entry) => (
                <ConnectionRow
                  key={entry.id}
                  entry={entry}
                  selected={selectedEntry?.id === entry.id}
                  onSelect={() =>
                    setParam({
                      selected: entry.counterpart_id || entry.request_id || entry.id,
                    })
                  }
                />
              ))}
            </div>

            <PaginatedListFooter
              page={page}
              limit={20}
              total={listState.total}
              hasMore={listState.hasMore}
              onPrevious={() => setParam({ page: String(Math.max(1, page - 1)) })}
              onNext={() => setParam({ page: String(page + 1) })}
            />
          </SettingsGroup>
        </section>
      </AppPageContentRegion>

      <SettingsDetailPanel
        open={Boolean(selectedEntry)}
        onOpenChange={(open) => {
          if (!open) setParam({ selected: null });
        }}
        title={selectedEntry?.counterpart_label || "Connection details"}
        description={selectedEntry ? connectionScopeSummary(selectedEntry) : "Select a connection"}
      >
        {!selectedEntry ? (
          <SettingsGroup
            embedded
            title="Select a connection"
            description="Choose a row to review next actions."
          >
            <SettingsRow
              title="Nothing selected yet"
              description="Pending, active, and previous connections open here."
            />
          </SettingsGroup>
        ) : (
          <div className="space-y-4">
            <SettingsGroup embedded title="Connection state" description="This connection and any Kai access stay together here.">
              <SettingsRow title="Status" description={formatStatus(selectedEntry.status)} />
              <SettingsRow
                title="Shared access"
                description={
                  <span className="inline-flex items-center gap-2">
                    {selectedEntry.scope_color_hex ? (
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: selectedEntry.scope_color_hex }}
                      />
                    ) : null}
                    {selectedEntry.scope_description || selectedEntry.scope || "Not shared yet"}
                  </span>
                }
              />
              {selectedEntry.issued_at ? (
                <SettingsRow title="Updated" description={formatDate(selectedEntry.issued_at) || "Unknown"} />
              ) : null}
              {actor === "ria" && detailLoading ? (
                <div className="space-y-3 px-4 py-2">
                  <Skeleton className="h-5 w-3/4 rounded-lg" />
                  <Skeleton className="h-5 w-1/2 rounded-lg" />
                  <Skeleton className="h-5 w-2/3 rounded-lg" />
                </div>
              ) : null}
              {actor === "ria" && !detailLoading && riaWorkspace ? (
                <SettingsRow
                  title="Kai workspace"
                  description={
                    riaWorkspace.workspace_ready
                      ? `${riaWorkspace.available_domains.length} readable domain${riaWorkspace.available_domains.length === 1 ? "" : "s"} available`
                      : (riaWorkspace.granted_scopes?.length ?? 0) === 0
                        ? "Portfolio access not yet granted. Request it below."
                        : "Portfolio data is being indexed. This usually takes a few minutes."
                  }
                />
              ) : null}
            </SettingsGroup>

            {canReviewPending(actor, selectedEntry) ? (
              <SettingsGroup embedded title="Pending action" description="Review this connection request.">
                <div className="flex flex-wrap gap-2 px-4 py-1">
                  <Button
                    variant="blue-gradient"
                    effect="fill"
                    size="sm"
                    onClick={() => void handleApprove(toPendingConsent(selectedEntry))}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    onClick={() => setConfirmDeclineOpen(true)}
                  >
                    Decline
                  </Button>
                </div>
              </SettingsGroup>
            ) : null}

            {actor === "ria" && riaDetail && detailOptions.length > 0 ? (
              <SettingsGroup
                embedded
                title="Kai portfolio access"
                description="Request access directly from this connection. The investor reviews the request in Consent manager."
              >
                <div className="divide-y divide-border/60 px-4">
                  {detailOptions.map((option) => {
                    const template = detailTemplateMap.get(option.templateId);
                    return (
                      <div key={option.id} className="flex items-start justify-between gap-3 py-3">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-foreground">{option.label}</p>
                          <p className="text-sm leading-6 text-muted-foreground">
                            {option.description}
                          </p>
                        </div>
                        <Button
                          variant="none"
                          effect="fade"
                          size="sm"
                          disabled={!template || requestingAccessId === selectedEntry.counterpart_id}
                          onClick={() => {
                            if (template) void handleRequestAccess(template, option.scopes);
                          }}
                        >
                          Request
                        </Button>
                      </div>
                    );
                  })}
                  {canOpenPortfolio ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="blue-gradient"
                        effect="fill"
                        size="sm"
                        onClick={() =>
                          router.push(
                            buildMarketplaceConnectionPortfolioRoute(selectedEntry.counterpart_id)
                          )
                        }
                      >
                        Open portfolio explorer
                        <ArrowUpRight className="ml-2 h-4 w-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </SettingsGroup>
            ) : null}

            {actor === "ria" && riaWorkspace?.domain_summaries?.financial ? (
              <SettingsGroup
                embedded
                title="Portfolio snapshot"
                description="This is the current Kai-readable portfolio summary for the granted scope."
              >
                <SettingsRow
                  title="Visible domains"
                  description={riaWorkspace.available_domains.join(", ") || "None"}
                />
                <SettingsRow
                  title="Attributes indexed"
                  description={String(riaWorkspace.total_attributes || 0)}
                />
              </SettingsGroup>
            ) : null}

            {String(selectedEntry.status || "").toLowerCase() === "active" ? (
              <SettingsGroup
                embedded
                title="Connection actions"
                description="Ending a connection immediately removes shared access while keeping history intact."
              >
                <div className="flex flex-wrap gap-2 px-4 py-1">
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    onClick={() => setConfirmDisconnectOpen(true)}
                    disabled={disconnectingId === selectedEntry.id}
                  >
                    {disconnectingId === selectedEntry.id ? "Ending..." : "Disconnect"}
                  </Button>
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    onClick={() => router.push(ROUTES.CONSENTS)}
                  >
                    Open Consent manager
                  </Button>
                </div>
              </SettingsGroup>
            ) : null}
          </div>
        )}
      </SettingsDetailPanel>
      <AlertDialog open={confirmDisconnectOpen} onOpenChange={setConfirmDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately removes all shared access and moves the connection to Previous. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDisconnectOpen(false);
                void handleDisconnect();
              }}
            >
              End connection
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDeclineOpen} onOpenChange={setConfirmDeclineOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline this connection request?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedEntry?.counterpart_label || "The requester"} will be notified that you declined. You can reconnect later from the marketplace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDeclineOpen(false);
                if (selectedEntry) {
                  void handleDeny(selectedEntry.request_id || selectedEntry.id);
                }
              }}
            >
              Decline request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppPageShell>
  );
}
