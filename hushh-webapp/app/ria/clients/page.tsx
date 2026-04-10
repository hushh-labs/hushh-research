"use client";

import { ChevronRight, Loader2, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  buildKaiTestClientAccess,
  canShowKaiTestProfile,
  getKaiTestUserId,
  isKaiTestProfileUser,
} from "@/components/ria/ria-client-test-profile";
import { SettingsGroup } from "@/components/profile/settings-ui";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Button } from "@/lib/morphy-ux/button";
import { buildRiaClientWorkspaceRoute, ROUTES } from "@/lib/navigation/routes";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import {
  RiaService,
  type RiaClientAccess,
  type RiaClientListResponse,
} from "@/lib/services/ria-service";
import { cn } from "@/lib/utils";
import { RiaCompatibilityState } from "@/components/ria/ria-page-shell";

type ClientListItem = RiaClientAccess & {
  isTestProfile?: boolean;
};

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

export default function RiaClientsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { riaCapability, loading: personaLoading } = usePersonaState();
  const allowTestProfiles = canShowKaiTestProfile();
  const kaiTestUserId = getKaiTestUserId();

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
    () => (clientsResource.data?.items || []).filter((client) => client.status === "approved"),
    [clientsResource.data?.items]
  );

  const injectedTestClient = useMemo<ClientListItem | null>(() => {
    if (!allowTestProfiles || !kaiTestUserId) return null;
    if (connectedClients.some((client) => client.investor_user_id === kaiTestUserId)) return null;
    return {
      ...buildKaiTestClientAccess(kaiTestUserId),
      isTestProfile: true,
    };
  }, [allowTestProfiles, connectedClients, kaiTestUserId]);

  const clientItems = useMemo<ClientListItem[]>(
    () => {
      const normalizedClients = connectedClients.map((client) => ({
        ...client,
        isTestProfile: isKaiTestProfileUser(client.investor_user_id),
      }));
      return injectedTestClient ? [injectedTestClient, ...normalizedClients] : normalizedClients;
    },
    [connectedClients, injectedTestClient]
  );

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
        <RiaCompatibilityState
          title="Complete RIA onboarding"
          description="Finish onboarding to access the client roster."
        />
      </>
    );
  }

  return (
    <AppPageShell
      as="main"
      width="expanded"
      className="pb-24 sm:pb-28"
      nativeTest={{
        routeId: "/ria/clients",
        marker: "native-route-ria-clients",
        authState: user ? "authenticated" : "pending",
        dataState: clientsResource.loading
          ? "loading"
          : clientItems.length > 0
            ? "loaded"
            : "empty-valid",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Clients"
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              Client roster
              {clientItems.length > 0 ? (
                <Badge variant="secondary" className="text-[10px]">
                  {clientItems.length}
                </Badge>
              ) : null}
            </span>
          }
          description="Open dedicated client workspaces for relationship status, access management, Kai parity, and the structured explorer."
          icon={UserRound}
          accent="ria"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <div className="flex flex-col gap-8">
          <SettingsGroup
            embedded
            title="Connected investors"
            description="Open a client once and keep relationship state, access, Kai parity, and the explorer in the same workspace."
          >
            {clientsResource.loading ? (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading clients...
              </div>
            ) : clientItems.length === 0 ? (
              <div className="space-y-3 px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No connected investors yet.</p>
                <Button variant="none" effect="fade" size="sm" onClick={() => router.push(ROUTES.MARKETPLACE)}>
                  Browse the marketplace
                </Button>
              </div>
            ) : (
              clientItems.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() =>
                    router.push(
                      buildRiaClientWorkspaceRoute(client.investor_user_id || "", {
                        tab: "overview",
                        testProfile: client.isTestProfile,
                      })
                    )
                  }
                  className={cn(
                    "relative w-full overflow-hidden px-4 py-3 text-left transition-colors hover:bg-muted/35"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                      <UserRound className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {client.investor_display_name || client.investor_user_id || "Investor"}
                        </p>
                        {client.isTestProfile ? (
                          <span className="shrink-0 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700">
                            Test
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {client.investor_email || client.investor_secondary_label || "Connected"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge className={cn("text-[10px]", statusBadgeClass(client.status))}>
                        {formatStatus(client.status)}
                      </Badge>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                  <MaterialRipple variant="none" effect="fade" className="z-0" />
                </button>
              ))
            )}
          </SettingsGroup>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
