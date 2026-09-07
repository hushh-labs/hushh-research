"use client";

import { ChevronRight, Loader2, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import {
  buildKaiTestClientAccess,
  canShowKaiTestProfile,
  getKaiTestUserId,
  isKaiTestProfileUser,
} from "@/components/ria/ria-client-test-profile";
import { NearbyAroundYou } from "@/components/ria/nearby/nearby-around-you";
import { SettingsGroup, SegmentedTabs } from "@/components/profile/settings-ui";
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
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { RIA_TONE_BADGE } from "@/lib/ria/ria-tone";
import { RIA_COPY } from "@/lib/ria/ria-screen-copy";
import { cn } from "@/lib/utils";
import { RiaCompatibilityState, RiaVerificationGate } from "@/components/ria/ria-page-shell";

type ClientListItem = RiaClientAccess & {
  isTestProfile?: boolean;
};

type ClientsView = "connected" | "nearby";

function statusBadgeClass(status?: string | null) {
  switch (status) {
    case "approved":
      return RIA_TONE_BADGE.success;
    case "request_pending":
      return RIA_TONE_BADGE.attention;
    default:
      return RIA_TONE_BADGE.neutral;
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
  // Session-only: an advisor lands on their roster, and prospecting is a
  // deliberate second step rather than the default view.
  const [view, setView] = useState<ClientsView>("connected");

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
  const voiceSurfaceMetadata = useMemo(
    () => ({
      screenId: "ria_clients",
      title: "RIA Clients",
      purpose: "Connected investor roster for opening advisor client workspaces.",
      sections: [
        {
          id: "ria_clients_roster",
          title: "Connected investors",
        },
      ],
      controls: [
        {
          id: "ria_route_tab_clients",
          label: "Clients",
          type: "tab",
          state: "active",
          actionId: "route.ria_clients",
        },
        {
          id: "ria_clients_browse_marketplace",
          label: "Browse the marketplace",
          type: "button",
          actionId: "route.ria_marketplace_connect",
        },
        ...clientItems.slice(0, 8).map((client, index) => ({
          id: `ria_clients_client_row_${index + 1}`,
          label: client.investor_display_name || client.investor_email || "Investor",
          type: "button",
          actionId: "ria.clients.open_client_workspace",
          description: client.investor_user_id || null,
        })),
      ],
      activeTab: "clients",
      visibleModules: ["Connected investors"],
      selectedObjects: clientItems
        .slice(0, 8)
        .map((client) => client.investor_display_name || client.investor_email || client.investor_user_id)
        .filter((value): value is string => Boolean(value)),
      screenMetadata: {
        connected_client_count: clientItems.length,
        loading: clientsResource.loading,
      },
    }),
    [clientItems, clientsResource.loading]
  );
  usePublishVoiceSurfaceMetadata(voiceSurfaceMetadata);

  // Wired in the generated gateway as execution_target.path: "control" --
  // the segmented Connected/Nearby toggle the person taps directly, not a
  // route or a named function. The executor already dispatches "control"
  // through this same handler registry; it just needed one registered.
  useLocalOnboardingActionHandler("ria.clients.switch_to_nearby", () => {
    setView("nearby");
    return { status: "succeeded" as const, summary: "Showing nearby clients." };
  });

  if (personaLoading) return null;
  if (riaCapability === "setup") {
    return (
      <>
        <AppPageShell
          as="main"
          width="agent"
          nativeTest={{
            routeId: "/ria/clients",
            marker: "native-route-ria-clients",
            authState: user ? "authenticated" : "pending",
            dataState: "unavailable-valid",
          }}
        />
        <RiaCompatibilityState
          title={RIA_COPY.clients.setupGate.title}
          description={RIA_COPY.clients.setupGate.description}
        />
      </>
    );
  }

  return (
    <AppPageShell
      as="main"
      width="agent"
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
      <AppPageHeaderRegion className="pt-2 sm:pt-3">
        <PageHeader
          eyebrow={RIA_COPY.clients.eyebrow}
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              {RIA_COPY.clients.title}
              {view === "connected" && clientItems.length > 0 ? (
                <Badge variant="secondary" className="text-[10px]">
                  {clientItems.length}
                </Badge>
              ) : null}
            </span>
          }
          description={RIA_COPY.clients.description}
          icon={UserRound}
          accent="ria"
          titleRole="agent"
          className="[&>div:first-child]:!gap-3.5 [&_[data-slot=page-header-row]]:!items-center"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <RiaVerificationGate>
        <SurfaceStack className="gap-8">
          {/* Connected is the roster of investors who already granted access.
              Around you is prospecting against public records — a different
              kind of person entirely, which is why they are separate views on
              one screen rather than one merged list. */}
          <div data-voice-control-id="ria_clients_view_switch">
            <SegmentedTabs
              value={view}
              onValueChange={(next) => setView(next as ClientsView)}
              options={[
                { value: "connected", label: "Connected" },
                { value: "nearby", label: "Around you" },
              ]}
            />
          </div>

          {view === "nearby" ? (
            <NearbyAroundYou />
          ) : (
          <SettingsGroup
            embedded
            title={RIA_COPY.clients.section.title}
            description={RIA_COPY.clients.section.description}
          >
            {clientsResource.loading ? (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {RIA_COPY.clients.loading}
              </div>
            ) : clientItems.length === 0 ? (
              <div className="space-y-3 px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">{RIA_COPY.clients.empty}</p>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  data-voice-control-id="ria_clients_browse_marketplace"
                  onClick={() => router.push(ROUTES.MARKETPLACE)}
                >
                  {RIA_COPY.clients.browse}
                </Button>
              </div>
            ) : (
              clientItems.map((client, index) => (
                <button
                  key={client.id}
                  type="button"
                  data-voice-control-id={`ria_clients_client_row_${index + 1}`}
                  data-testid={client.isTestProfile ? "ria-client-test-profile" : undefined}
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
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--foundation-accent-surface)] text-[color:var(--ria-gold)]">
                      <UserRound className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {client.investor_display_name || client.investor_user_id || "Investor"}
                        </p>
                        {client.isTestProfile ? (
                          <span className="shrink-0 rounded-full border border-[color:var(--foundation-accent-border)] bg-[color:var(--foundation-accent-surface)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ria-gold)]">
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
          )}
        </SurfaceStack>
        </RiaVerificationGate>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
