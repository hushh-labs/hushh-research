"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Loader2, WalletCards } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { RiaSurface } from "@/components/ria/ria-page-shell";
import { useAuth } from "@/hooks/use-auth";
import { usePersonaState } from "@/lib/persona/persona-context";
import { Button } from "@/lib/morphy-ux/button";
import {
  buildMarketplaceConnectionsRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { ConnectionCenterService } from "@/lib/services/connection-center-service";
import { RiaService } from "@/lib/services/ria-service";

type WorkspacePayload = Awaited<ReturnType<typeof RiaService.getWorkspace>>;

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
    ["Holdings", financial.holdings_count || financial.investable_positions_count || financial.item_count || financial.attribute_count],
    ["Cash positions", financial.cash_positions_count],
    ["Cash", asPercent(allocation.cash)],
    ["Equities", asPercent(allocation.equities)],
    ["Bonds", asPercent(allocation.bonds)],
  ] as const;
  return keys.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
}

const ALLOCATION_COLORS: Record<string, string> = {
  equities: "#3B82F6",
  bonds: "#F59E0B",
  cash: "#10B981",
  other: "#94A3B8",
};

function AllocationBar({ allocation }: { allocation: Record<string, unknown> }) {
  const segments = ["equities", "bonds", "cash", "other"]
    .map((key) => ({ key, value: Number(allocation[key]) || 0 }))
    .filter((s) => s.value > 0);
  if (segments.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {segments.map((s) => (
          <div
            key={s.key}
            className="h-full transition-all"
            style={{
              width: `${Math.round(s.value * 100)}%`,
              backgroundColor: ALLOCATION_COLORS[s.key] || "#94A3B8",
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: ALLOCATION_COLORS[s.key] || "#94A3B8" }}
            />
            <span className="capitalize">{s.key}</span>
            <span className="font-medium text-foreground">{Math.round(s.value * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ConnectionPortfolioPageClient({
  connectionId,
}: {
  connectionId: string;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const { activePersona } = usePersonaState();
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!user || activePersona !== "ria" || !connectionId) return;
      try {
        setLoading(true);
        setError(null);
        const idToken = await user.getIdToken();
        const payload = await ConnectionCenterService.getRiaConnectionWorkspace({
          idToken,
          userId: user.uid,
          investorUserId: connectionId,
          force: true,
        });
        if (cancelled) return;
        setWorkspace(payload);
      } catch (loadError) {
        if (cancelled) return;
        setWorkspace(null);
        setError(loadError instanceof Error ? loadError.message : "Failed to load portfolio explorer");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [activePersona, connectionId, user]);

  const financialSummary = useMemo(
    () => asRecord(asRecord(workspace?.domain_summaries).financial),
    [workspace?.domain_summaries]
  );
  const summaryRows = useMemo(() => scalarSummaryRows(financialSummary), [financialSummary]);

  if (activePersona !== "ria") {
    return (
      <AppPageShell
        as="main"
        width="profile"
        className="pb-24"
        nativeTest={{
          routeId: "/marketplace/connections/portfolio",
          marker: "native-route-marketplace-connections-portfolio",
          authState: user ? "authenticated" : "pending",
          dataState: "unavailable-valid",
        }}
      >
        <AppPageHeaderRegion>
          <PageHeader
            eyebrow="Connect"
            title="Portfolio explorer"
            description="This read-only explorer opens from an active advisor connection."
            icon={WalletCards}
          />
        </AppPageHeaderRegion>
        <AppPageContentRegion>
          <RiaSurface className="p-5">
            <p className="text-sm text-muted-foreground">
              Portfolio explorer is currently available from the advisor side of an active connection.
            </p>
          </RiaSurface>
        </AppPageContentRegion>
      </AppPageShell>
    );
  }

  return (
    <AppPageShell
      as="main"
      width="profile"
      className="pb-24"
      nativeTest={{
        routeId: "/marketplace/connections/portfolio",
        marker: "native-route-marketplace-connections-portfolio",
        authState: user ? "authenticated" : "pending",
        dataState: loading
          ? "loading"
          : workspace
            ? "loaded"
            : error
              ? "unavailable-valid"
              : "empty-valid",
        errorCode: error ? "connection_portfolio" : null,
        errorMessage: error,
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Connect"
          title={workspace?.investor_display_name || "Portfolio explorer"}
          description="Read-only Kai portfolio view for a granted connection scope."
          icon={WalletCards}
          actions={
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() =>
                router.push(buildMarketplaceConnectionsRoute({ tab: "active", selected: connectionId }))
              }
            >
              Back to connections
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="space-y-4">
        {loading ? (
          <RiaSurface className="p-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading portfolio explorer...
            </div>
          </RiaSurface>
        ) : null}

        {error ? (
          <RiaSurface className="border-red-500/20 bg-red-500/5 p-5">
            <p className="text-sm text-red-500">{error}</p>
          </RiaSurface>
        ) : null}

        {!loading && !error && workspace ? (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <RiaSurface className="p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Scope</p>
                <p className="mt-2 text-lg font-semibold text-foreground">
                  {workspace.granted_scopes?.map((item) => item.label).join(", ") || "Not granted"}
                </p>
              </RiaSurface>
              <RiaSurface className="p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Workspace</p>
                <p className="mt-2 text-lg font-semibold text-foreground">
                  {workspace.workspace_ready ? "Ready" : "Locked"}
                </p>
              </RiaSurface>
              <RiaSurface className="p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Domains</p>
                <p className="mt-2 text-lg font-semibold text-foreground">
                  {workspace.available_domains.length}
                </p>
              </RiaSurface>
              <RiaSurface className="p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Indexed attributes</p>
                <p className="mt-2 text-lg font-semibold text-foreground">
                  {workspace.total_attributes}
                </p>
              </RiaSurface>
            </div>

            <RiaSurface className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    Portfolio overview
                  </p>
                  <h2 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                    Shared Kai portfolio summary
                  </h2>
                </div>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => router.push(ROUTES.CONSENTS)}
                >
                  Open Consent manager
                </Button>
              </div>

              {Object.keys(asRecord(financialSummary.asset_allocation_pct)).length > 0 ? (
                <div className="mt-4">
                  <AllocationBar allocation={asRecord(financialSummary.asset_allocation_pct)} />
                </div>
              ) : null}

              {summaryRows.length > 0 ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {summaryRows.map(([label, value]) => (
                    <div key={label} className="rounded-[var(--radius-md)] bg-background/50 p-4 dark:bg-white/5">
                      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
                      <p className="mt-2 text-lg font-semibold text-foreground">{String(value)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm leading-6 text-muted-foreground">
                  The granted scope is active, but this connection has not materialized a financial summary yet.
                </p>
              )}

              {workspace.updated_at ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Last updated {new Date(workspace.updated_at).toLocaleString()}
                </p>
              ) : null}
            </RiaSurface>

            <RiaSurface className="flex flex-wrap items-center justify-between gap-3 p-4">
              <p className="text-sm text-muted-foreground">
                Need deeper access to this investor&apos;s data?
              </p>
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={() =>
                  router.push(buildMarketplaceConnectionsRoute({ tab: "active", selected: connectionId }))
                }
              >
                Request more access
                <ArrowUpRight className="ml-2 h-4 w-4" />
              </Button>
            </RiaSurface>
          </>
        ) : null}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
