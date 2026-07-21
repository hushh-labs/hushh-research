"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  BriefcaseBusiness,
  CircleAlert,
} from "lucide-react";

import { RiaCompatibilityState, RiaPageShell, RiaSurface } from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { RiaService, type RiaHomeResponse } from "@/lib/services/ria-service";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { ROUTES } from "@/lib/navigation/routes";
import { InlineLoadingState } from "@/components/app-ui/inline-loading-state";
import {
  NativeTestBeacon,
  type NativeTestDataState,
} from "@/components/app-ui/native-test-beacon";
import { RIA_TONE_BADGE, RIA_TONE_SURFACE } from "@/lib/ria/ria-tone";
import { RIA_COPY } from "@/lib/ria/ria-screen-copy";
import { cn } from "@/lib/utils";

type HeroTone = "neutral" | "warning" | "success" | "critical";

const EMPTY_QUEUE_ITEMS: RiaHomeResponse["needs_attention"] = [];

function verificationState(status?: string | null) {
  const copy = RIA_COPY.home.verification;
  switch (status) {
    case "active":
    case "verified":
      return { ...copy.active, tone: "success" as HeroTone };
    case "submitted":
      return { ...copy.submitted, tone: "warning" as HeroTone };
    case "rejected":
      return { ...copy.rejected, tone: "critical" as HeroTone };
    default:
      return { ...copy.draft, tone: "neutral" as HeroTone };
  }
}

function heroToneClass(tone: HeroTone) {
  switch (tone) {
    case "success":
      return RIA_TONE_SURFACE.success;
    case "warning":
      return RIA_TONE_SURFACE.attention;
    case "critical":
      return RIA_TONE_SURFACE.critical;
    case "neutral":
    default:
      return RIA_TONE_SURFACE.neutral;
  }
}

function badgeToneClass(tone: HeroTone) {
  switch (tone) {
    case "success":
      return RIA_TONE_BADGE.success;
    case "warning":
      return RIA_TONE_BADGE.attention;
    case "critical":
      return RIA_TONE_BADGE.critical;
    case "neutral":
    default:
      return RIA_TONE_BADGE.neutral;
  }
}

function queueToneClass(status?: string | null) {
  switch (status) {
    case "approved":
      return RIA_TONE_BADGE.success;
    case "request_pending":
    case "submitted":
      return RIA_TONE_BADGE.attention;
    case "rejected":
    case "revoked":
    case "expired":
    case "disconnected":
      return RIA_TONE_BADGE.critical;
    default:
      return RIA_TONE_BADGE.neutral;
  }
}

function formatStatusLabel(status?: string | null) {
  return String(status || "pending").replaceAll("_", " ");
}

function SummaryCell({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="space-y-1 bg-white px-4 py-4 sm:px-5"
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--ria-sublabel)]">
        {label}
      </p>
      <p className="text-lg font-semibold tracking-tight tabular-nums text-[color:var(--ria-ink)]">
        {value}
      </p>
      <p className="text-xs leading-5 text-[color:var(--ria-muted)]">{helper}</p>
    </div>
  );
}

export default function RiaHomePage() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    riaCapability,
    riaOnboardingStatus,
    loading: personaLoading,
    refreshing: personaRefreshing,
  } = usePersonaState();

  useEffect(() => {
    if (personaLoading || personaRefreshing) return;
    // "setup" (never onboarded) OR a deleted profile whose persona is still/again
    // 'ria' (exists:false) → send to onboarding for a clean new-user experience.
    if (riaCapability === "setup" || riaOnboardingStatus?.exists === false) {
      router.replace(ROUTES.RIA_ONBOARDING);
    }
  }, [
    personaLoading,
    personaRefreshing,
    riaCapability,
    riaOnboardingStatus,
    router,
  ]);

  const homeResource = useStaleResource<RiaHomeResponse>({
    cacheKey: user?.uid ? `ria_home_${user.uid}` : "ria_home_guest",
    enabled: Boolean(user?.uid && (riaCapability !== "setup" || personaRefreshing)),
    load: async () => {
      if (!user?.uid) {
        throw new Error("Sign in to access the RIA workspace");
      }
      const idToken = await user.getIdToken();
      return RiaService.getHome(idToken, {
        userId: user.uid,
      });
    },
  });

  const verification = verificationState(homeResource.data?.verification_status);
  const iamUnavailable = Boolean(homeResource.error?.includes("IAM schema"));
  const activeClients = homeResource.data?.counts.active_clients ?? 0;
  const needsAttention = homeResource.data?.counts.needs_attention ?? 0;
  const inviteCount = homeResource.data?.counts.invites ?? 0;
  const queueItems = homeResource.data?.needs_attention ?? EMPTY_QUEUE_ITEMS;
  const leadItem = queueItems[0] ?? null;
  const heroTitle =
    leadItem?.title ||
    (activeClients > 0
      ? `You have ${activeClients} active client relationship${activeClients === 1 ? "" : "s"}.`
      : verification.title);
  const heroDescription = leadItem?.subtitle || leadItem?.next_action || verification.description;
  const voiceControls = useMemo(
    () => [
      {
        id: "ria_route_tab_home",
        label: "Home",
        type: "tab",
        state: "active",
        actionId: "route.ria_home",
      },
      {
        id: "ria_route_tab_clients",
        label: "Clients",
        type: "tab",
        actionId: "route.ria_clients",
      },
      {
        id: "ria_route_tab_connect",
        label: "Connect",
        type: "tab",
        actionId: "route.ria_marketplace_connect",
      },
      {
        id: "ria_route_tab_picks",
        label: "Picks",
        type: "tab",
        actionId: "route.ria_picks",
      },
      ...queueItems.slice(0, 5).map((item, index) => ({
        id: `ria_home_priority_item_open_${index + 1}`,
        label: item.title || `Priority item ${index + 1}`,
        type: "button",
        actionId: "ria.home.open_priority_item",
        description: item.next_action || item.subtitle || null,
      })),
    ],
    [queueItems]
  );

  const voiceSurfaceMetadata = useMemo(
    () => ({
      screenId: "ria_home",
      title: "RIA Home",
      purpose: "Advisor workspace home with readiness, relationship counts, and priority queue.",
      sections: [
        {
          id: "ria_home_readiness",
          title: "Readiness",
        },
        {
          id: "ria_home_priority_queue",
          title: "Priority queue",
        },
      ],
      controls: voiceControls,
      activeTab: "home",
      visibleModules: ["Readiness", "Priority queue", "Relationships"],
      availableActions: ["Open RIA Clients", "Open RIA Picks", "Open RIA Connect Marketplace"],
      screenMetadata: {
        verification_status: homeResource.data?.verification_status || null,
        active_clients: activeClients,
        needs_attention: needsAttention,
        invite_count: inviteCount,
        priority_items_visible: queueItems.length,
      },
    }),
    [
      activeClients,
      homeResource.data?.verification_status,
      inviteCount,
      needsAttention,
      queueItems.length,
      voiceControls,
    ]
  );
  usePublishVoiceSurfaceMetadata(voiceSurfaceMetadata);

  // Hold a neutral loader instead of painting the RIA home hero while we're about
  // to redirect a not-onboarded user (or while persona state is still resolving),
  // so the home chrome never flashes before landing on onboarding. Mirrors the
  // onboarding page's entry guard. A "disabled"/IAM advisor is NOT held here
  // (handled via homeResource.error / RiaCompatibilityState below), so an
  // established advisor is never trapped in the loader.
  const redirectingToOnboarding =
    riaCapability === "setup" || riaOnboardingStatus?.exists === false;
  if (personaLoading || personaRefreshing || redirectingToOnboarding) {
    const holdDataState: NativeTestDataState = redirectingToOnboarding
      ? "redirect-valid"
      : "loading";
    return (
      <>
        <NativeTestBeacon
          routeId="/ria"
          marker="native-route-ria-home"
          authState={user ? "authenticated" : "pending"}
          dataState={holdDataState}
          errorCode={null}
          errorMessage={null}
        />
        <InlineLoadingState
          label="Loading…"
          className="min-h-[60dvh] justify-center"
        />
      </>
    );
  }

  return (
    <RiaPageShell
      width="expanded"
      eyebrow={RIA_COPY.home.eyebrow}
      title={RIA_COPY.home.title}
      description={RIA_COPY.home.description}
      icon={BriefcaseBusiness}
      nativeTest={{
        routeId: "/ria",
        marker: "native-route-ria-home",
        authState: user ? "authenticated" : "pending",
        dataState: homeResource.loading && !homeResource.data
          ? "loading"
          : iamUnavailable
            ? "unavailable-valid"
            : "loaded",
        errorCode: homeResource.error ? "ria_home" : null,
        errorMessage: homeResource.error,
      }}
      statusPanel={
        iamUnavailable ? null : (
          <RiaSurface
            accent="ria"
            className={cn("space-y-5 p-5 sm:p-6", heroToneClass(verification.tone))}
            data-testid="ria-home-primary"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-3">
                <Badge className={cn("w-fit", badgeToneClass(verification.tone))}>
                  {verification.label}
                </Badge>
                <div className="space-y-2">
                  <h2 className="text-[clamp(1.25rem,3vw,1.85rem)] font-semibold tracking-tight text-foreground">
                    {heroTitle}
                  </h2>
                  <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-[15px]">
                    {heroDescription}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-px overflow-hidden rounded-[22px] bg-border/60 sm:grid-cols-2 md:grid-cols-3 [&>*:last-child:nth-child(2n+1)]:sm:col-span-2 [&>*:last-child:nth-child(2n+1)]:md:col-span-1">
              <SummaryCell
                label={RIA_COPY.home.summary.relationships.label}
                value={String(activeClients)}
                helper={
                  activeClients > 0
                    ? RIA_COPY.home.summary.relationships.has
                    : RIA_COPY.home.summary.relationships.empty
                }
              />
              <SummaryCell
                label={RIA_COPY.home.summary.priority.label}
                value={String(needsAttention)}
                helper={
                  needsAttention > 0
                    ? RIA_COPY.home.summary.priority.has
                    : RIA_COPY.home.summary.priority.empty
                }
              />
              <SummaryCell
                label={RIA_COPY.home.summary.invites.label}
                value={String(inviteCount)}
                helper={
                  inviteCount > 0
                    ? RIA_COPY.home.summary.invites.has
                    : RIA_COPY.home.summary.invites.empty
                }
              />
            </div>
          </RiaSurface>
        )
      }
    >
      {iamUnavailable ? (
        <RiaCompatibilityState
          title={RIA_COPY.home.iam.title}
          description={RIA_COPY.home.iam.description}
        />
      ) : null}

      {!iamUnavailable ? (
        <div className="grid gap-4">
          <RiaSurface className="space-y-4 p-4 sm:p-5" data-testid="ria-home-queue">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold tracking-tight text-foreground">
                  {RIA_COPY.home.queue.heading}
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  {RIA_COPY.home.queue.description}
                </p>
              </div>
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/55 bg-background/70 text-muted-foreground">
                <CircleAlert className="h-4.5 w-4.5" />
              </span>
            </div>

            <div className="overflow-hidden rounded-[20px] border border-border/60 bg-background/70">
              {homeResource.loading && !homeResource.data ? (
                <InlineLoadingState label={RIA_COPY.home.queue.loading} />
              ) : null}

              {!homeResource.loading && queueItems.length === 0 ? (
                <div className="px-4 py-5 text-sm text-muted-foreground">
                  {RIA_COPY.home.queue.empty}
                </div>
              ) : null}

              {queueItems.slice(0, 4).map((item, index) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-start justify-between gap-3 px-4 py-4",
                    index > 0 && "border-t border-border/55"
                  )}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold tracking-tight text-foreground">
                        {item.title}
                      </span>
                      <Badge className={cn("capitalize", queueToneClass(item.status))}>
                        <span className="sr-only">Status: </span>
                        {formatStatusLabel(item.status)}
                      </Badge>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {item.subtitle || item.next_action || RIA_COPY.home.queue.itemFallback}
                    </p>
                  </div>
                  <Link
                    href={item.href}
                    data-voice-control-id={`ria_home_priority_item_open_${index + 1}`}
                    aria-label={`Open ${item.title}`}
                    className="shrink-0 text-sm font-medium text-foreground/82 transition-colors hover:text-foreground"
                  >
                    Open
                  </Link>
                </div>
              ))}
            </div>
          </RiaSurface>
        </div>
      ) : null}
    </RiaPageShell>
  );
}
