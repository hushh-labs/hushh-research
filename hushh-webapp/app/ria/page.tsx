"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  BriefcaseBusiness,
  CircleAlert,
  Loader2,
} from "lucide-react";

import { RiaCompatibilityState, RiaPageShell, RiaSurface } from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { RiaService, type RiaHomeResponse } from "@/lib/services/ria-service";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

type HeroTone = "neutral" | "warning" | "success" | "critical";

function verificationState(status?: string | null) {
  switch (status) {
    case "active":
    case "verified":
    case "bypassed":
      return {
        label: "Ready",
        title: "Your advisor workspace is ready.",
        description: "Relationships, picks, and investor requests can move without extra setup.",
        tone: "success" as HeroTone,
      };
    case "submitted":
      return {
        label: "In review",
        title: "Verification is still moving.",
        description: "The workflow stays readable while trust checks finish in the background.",
        tone: "warning" as HeroTone,
      };
    case "rejected":
      return {
        label: "Needs update",
        title: "A few trust details need another pass.",
        description: "Refresh the profile so investor access and advisor sharing can continue cleanly.",
        tone: "critical" as HeroTone,
      };
    default:
      return {
        label: "Draft",
        title: "Finish the advisor setup once.",
        description: "After that, the rest of the RIA workflow stays in the background.",
        tone: "neutral" as HeroTone,
      };
  }
}

function heroToneClass(tone: HeroTone) {
  switch (tone) {
    case "success":
      return "border-emerald-500/20 bg-emerald-500/[0.08]";
    case "warning":
      return "border-amber-500/20 bg-amber-500/[0.09]";
    case "critical":
      return "border-rose-500/20 bg-rose-500/[0.08]";
    case "neutral":
    default:
      return "border-border/65 bg-background/78";
  }
}

function badgeToneClass(tone: HeroTone) {
  switch (tone) {
    case "success":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "warning":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "critical":
      return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "neutral":
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

function queueToneClass(status?: string | null) {
  switch (status) {
    case "approved":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "request_pending":
    case "submitted":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "rejected":
    case "revoked":
    case "expired":
    case "disconnected":
      return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    default:
      return "border-border/65 bg-background/80 text-muted-foreground";
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
    <div className="space-y-1 bg-background/58 px-4 py-4 sm:px-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </p>
      <p className="text-lg font-semibold tracking-tight text-foreground">{value}</p>
      <p className="text-xs leading-5 text-muted-foreground">{helper}</p>
    </div>
  );
}

export default function RiaHomePage() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    riaCapability,
    loading: personaLoading,
    refreshing: personaRefreshing,
  } = usePersonaState();

  useEffect(() => {
    if (!personaLoading && !personaRefreshing && riaCapability === "setup") {
      router.replace(ROUTES.RIA_ONBOARDING);
    }
  }, [personaLoading, personaRefreshing, riaCapability, router]);

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
  const queueItems = homeResource.data?.needs_attention ?? [];
  const leadItem = queueItems[0] ?? null;
  const heroTitle =
    leadItem?.title ||
    (activeClients > 0
      ? `You have ${activeClients} active client relationship${activeClients === 1 ? "" : "s"}.`
      : verification.title);
  const heroDescription = leadItem?.subtitle || leadItem?.next_action || verification.description;

  return (
    <RiaPageShell
      eyebrow="RIA Home"
      title="Trusted advisor ops"
      description="See readiness, what needs attention, and where to go next without scanning a settings wall."
      icon={BriefcaseBusiness}
      statusPanel={
        iamUnavailable ? null : (
          <RiaSurface
            accent="sky"
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

            <div className="grid gap-px overflow-hidden rounded-[22px] bg-border/60 md:grid-cols-3">
              <SummaryCell
                label="Relationships"
                value={String(activeClients)}
                helper={
                  activeClients > 0
                    ? "Investor connections with an active relationship."
                    : "No client relationships are active yet."
                }
              />
              <SummaryCell
                label="Priority queue"
                value={String(needsAttention)}
                helper={
                  needsAttention > 0
                    ? "Only the next real decisions stay visible here."
                    : "Home stays quiet until something truly needs action."
                }
              />
              <SummaryCell
                label="Open invites"
                value={String(inviteCount)}
                helper={
                  inviteCount > 0
                    ? "Private links still waiting for investor response."
                    : "No invites are currently hanging in flight."
                }
              />
            </div>
          </RiaSurface>
        )
      }
    >
      {iamUnavailable ? (
        <RiaCompatibilityState
          title="RIA home is waiting on the IAM rollout"
          description="This environment still needs the IAM schema before advisor readiness and relationship data can load cleanly."
        />
      ) : null}

      {!iamUnavailable ? (
        <div className="grid gap-4">
          <RiaSurface className="space-y-4 p-4 sm:p-5" data-testid="ria-home-queue">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold tracking-tight text-foreground">
                  Priority queue
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  Relationships, approvals, and invites only appear here when they still need a
                  real move from you.
                </p>
              </div>
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/55 bg-background/70 text-muted-foreground">
                <CircleAlert className="h-4.5 w-4.5" />
              </span>
            </div>

            <div className="overflow-hidden rounded-[20px] border border-border/60 bg-background/70">
              {homeResource.loading && !homeResource.data ? (
                <div className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Pulling readiness, relationships, and picks state.
                </div>
              ) : null}

              {!homeResource.loading && queueItems.length === 0 ? (
                <div className="px-4 py-5 text-sm text-muted-foreground">
                  Nothing urgent right now. When a relationship, consent request, or invite needs
                  the next move, it will land here.
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
                        {formatStatusLabel(item.status)}
                      </Badge>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {item.subtitle || item.next_action || "Review the next step."}
                    </p>
                  </div>
                  <Link
                    href={item.href}
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
