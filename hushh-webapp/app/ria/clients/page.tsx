"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/profile/settings-ui";
import {
  RiaCompatibilityState,
} from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Button } from "@/lib/morphy-ux/button";
import {
  buildMarketplaceConnectionPortfolioRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import {
  RiaService,
  type RiaClientAccess,
  type RiaClientDetail,
  type RiaClientListResponse,
  type RiaRequestScopeTemplate,
} from "@/lib/services/ria-service";
import { cn } from "@/lib/utils";

function statusBadgeClass(status?: string | null) {
  switch (status) {
    case "approved":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "request_pending":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

function formatStatus(status?: string | null) {
  if (status === "approved") return "Connected";
  if (status === "request_pending") return "Pending";
  return String(status || "pending").replaceAll("_", " ");
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asPercent(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
}

export default function RiaClientsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { riaCapability, loading: personaLoading } = usePersonaState();

  const [selectedClient, setSelectedClient] = useState<RiaClientAccess | null>(null);
  const [detail, setDetail] = useState<RiaClientDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [workspace, setWorkspace] = useState<Awaited<ReturnType<typeof RiaService.getWorkspace>> | null>(null);
  const [requestingAccess, setRequestingAccess] = useState(false);

  const clientsResource = useStaleResource<RiaClientListResponse>({
    cacheKey: user?.uid ? `ria_clients_connected_${user.uid}` : "ria_clients_guest",
    enabled: Boolean(user?.uid && riaCapability !== "setup"),
    load: async () => {
      if (!user?.uid) throw new Error("Sign in to access clients");
      const idToken = await user.getIdToken();
      return RiaService.listClients(idToken, { userId: user.uid, page: 1, limit: 100 });
    },
  });

  const connectedClients = useMemo(
    () => (clientsResource.data?.items || []).filter((c) => c.status === "approved"),
    [clientsResource.data?.items]
  );

  // Load detail + workspace when a client is selected
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!user || !selectedClient?.investor_user_id) {
        setDetail(null);
        setWorkspace(null);
        return;
      }
      try {
        setDetailLoading(true);
        const idToken = await user.getIdToken();
        const [d, w] = await Promise.all([
          RiaService.getClientDetail(idToken, selectedClient.investor_user_id, { userId: user.uid }),
          RiaService.getWorkspace(idToken, selectedClient.investor_user_id, { userId: user.uid }).catch(() => null),
        ]);
        if (cancelled) return;
        setDetail(d);
        setWorkspace(w);
      } catch {
        if (!cancelled) { setDetail(null); setWorkspace(null); }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [selectedClient?.investor_user_id, user]);

  async function handleRequestAccess(template: RiaRequestScopeTemplate) {
    if (!user || !selectedClient?.investor_user_id) return;
    try {
      setRequestingAccess(true);
      const idToken = await user.getIdToken();
      await RiaService.createRequestBundle(idToken, {
        subject_user_id: selectedClient.investor_user_id,
        scope_template_id: template.template_id,
        selected_scopes: template.scopes.map((s) => s.scope),
        reason: "Kai portfolio access request",
      });
      toast.success("Access request sent", { description: "The investor will review it in Consent manager." });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send request");
    } finally {
      setRequestingAccess(false);
    }
  }

  if (personaLoading) return null;
  if (riaCapability === "setup") {
    return (
      <>
        <AppPageShell
          as="main"
          width="standard"
          nativeTest={{
            routeId: "/ria/clients",
            marker: "native-route-ria-clients",
            authState: user ? "authenticated" : "pending",
            dataState: "unavailable-valid",
          }}
        />
        <RiaCompatibilityState title="Complete RIA onboarding" description="Finish onboarding to access the client roster." />
      </>
    );
  }

  const financial = asRecord(asRecord(workspace?.domain_summaries).financial);
  const allocation = asRecord(financial.asset_allocation_pct);
  const hasFinancialData = Boolean(workspace?.workspace_ready && (financial.holdings_count || financial.attribute_count));
  const templates = detail?.requestable_scope_templates || [];

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="pb-28"
      nativeTest={{
        routeId: "/ria/clients",
        marker: "native-route-ria-clients",
        authState: user ? "authenticated" : "pending",
        dataState: clientsResource.loading
          ? "loading"
          : connectedClients.length > 0
            ? "loaded"
            : "empty-valid",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Clients"
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              Connected investors
              {connectedClients.length > 0 ? (
                <Badge variant="secondary" className="text-[10px]">{connectedClients.length}</Badge>
              ) : null}
            </span>
          }
          description="Portfolio access and Kai permissions for your connected investors."
          icon={UserRound}
          accent="ria"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <div className="flex flex-col gap-8">
          <SettingsGroup embedded>
            {clientsResource.loading ? (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading clients...
              </div>
            ) : connectedClients.length === 0 ? (
              <div className="space-y-3 px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No connected investors yet.</p>
                <Button variant="none" effect="fade" size="sm" onClick={() => router.push(ROUTES.MARKETPLACE)}>
                  Browse the marketplace
                </Button>
              </div>
            ) : (
              connectedClients.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => setSelectedClient(client)}
                  className={cn(
                    "relative w-full overflow-hidden px-4 py-3 text-left transition-colors",
                    selectedClient?.id === client.id
                      ? "bg-sky-500/6"
                      : "hover:bg-muted/35"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                      <UserRound className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {client.investor_display_name || client.investor_user_id || "Investor"}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {client.investor_email || client.investor_secondary_label || "Connected"}
                      </p>
                    </div>
                    <Badge className={cn("shrink-0 text-[10px]", statusBadgeClass(client.status))}>
                      {formatStatus(client.status)}
                    </Badge>
                  </div>
                  <MaterialRipple variant="none" effect="fade" className="z-0" />
                </button>
              ))
            )}
          </SettingsGroup>
        </div>
      </AppPageContentRegion>

      <SettingsDetailPanel
        open={Boolean(selectedClient)}
        onOpenChange={(open) => { if (!open) setSelectedClient(null); }}
        title={selectedClient?.investor_display_name || "Client details"}
        description={selectedClient ? formatStatus(selectedClient.status) : "Select a client"}
      >
        {detailLoading ? (
          <div className="space-y-3 px-4 py-2">
            <div className="h-5 w-3/4 animate-pulse rounded-lg bg-muted" />
            <div className="h-5 w-1/2 animate-pulse rounded-lg bg-muted" />
            <div className="h-5 w-2/3 animate-pulse rounded-lg bg-muted" />
          </div>
        ) : selectedClient ? (
          <div className="space-y-4">
            {/* Portfolio summary */}
            {hasFinancialData ? (
              <SettingsGroup embedded title="Kai portfolio" description="Financial data shared through the active consent.">
                <SettingsRow title="Holdings" description={String(financial.holdings_count || financial.attribute_count || 0)} />
                {financial.risk_profile ? (
                  <SettingsRow title="Risk profile" description={String(financial.risk_profile)} />
                ) : null}
                {allocation.equities ? (
                  <SettingsRow title="Equities" description={asPercent(allocation.equities) || "—"} />
                ) : null}
                {allocation.bonds ? (
                  <SettingsRow title="Bonds" description={asPercent(allocation.bonds) || "—"} />
                ) : null}
                {allocation.cash ? (
                  <SettingsRow title="Cash" description={asPercent(allocation.cash) || "—"} />
                ) : null}
                <div className="px-4 py-2">
                  <Button
                    variant="blue-gradient"
                    effect="fill"
                    size="sm"
                    onClick={() => router.push(buildMarketplaceConnectionPortfolioRoute(selectedClient.investor_user_id))}
                  >
                    Open portfolio explorer
                    <ArrowUpRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </SettingsGroup>
            ) : (
              <SettingsGroup embedded title="Kai portfolio" description="No portfolio data available yet.">
                <SettingsRow title="Status" description="Waiting for financial scope grant or portfolio indexing." />
              </SettingsGroup>
            )}

            {/* Granted scopes */}
            {detail?.granted_scopes && detail.granted_scopes.length > 0 ? (
              <SettingsGroup embedded title="Active permissions" description="Scopes the investor has granted.">
                {detail.granted_scopes.map((scope) => (
                  <SettingsRow
                    key={scope.scope}
                    title={scope.label || scope.scope}
                    description={scope.expires_at ? `Expires ${new Date(scope.expires_at).toLocaleDateString()}` : "No expiry"}
                  />
                ))}
              </SettingsGroup>
            ) : null}

            {/* Request more access */}
            {templates.length > 0 ? (
              <SettingsGroup embedded title="Request access" description="Ask the investor for additional permissions.">
                {templates.map((template) => (
                  <div key={template.template_id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">{template.template_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {template.scopes.map((s) => s.label).filter(Boolean).join(", ")}
                      </p>
                    </div>
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      disabled={requestingAccess}
                      onClick={() => void handleRequestAccess(template)}
                    >
                      Request
                    </Button>
                  </div>
                ))}
              </SettingsGroup>
            ) : null}
          </div>
        ) : null}
      </SettingsDetailPanel>
    </AppPageShell>
  );
}
