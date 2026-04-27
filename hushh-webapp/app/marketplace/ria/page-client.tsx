"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BadgeCheck, Building2, ShieldCheck } from "lucide-react";

import { RiaPageShell, RiaSurface } from "@/components/ria/ria-page-shell";
import { useAuth } from "@/hooks/use-auth";
import { usePersonaState } from "@/lib/persona/persona-context";
import { ROUTES, buildMarketplaceConnectionsRoute } from "@/lib/navigation/routes";
import {
  RiaService,
  type MarketplaceRia,
} from "@/lib/services/ria-service";
import {
  ConsentCenterService,
} from "@/lib/services/consent-center-service";
import { trackEvent } from "@/lib/observability/client";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

function verificationBadge(status: string) {
  const normalized = status.toLowerCase();
  switch (normalized) {
    case "active":
    case "verified":
    case "finra_verified":
      return {
        label: normalized === "finra_verified" ? "FINRA verified" : "Verified",
        className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700",
        icon: ShieldCheck,
      };
    case "bypassed":
      return {
        label: "Active",
        className: "border-sky-500/20 bg-sky-500/10 text-sky-700",
        icon: BadgeCheck,
      };
    case "submitted":
      return {
        label: "In review",
        className: "border-amber-500/20 bg-amber-500/10 text-amber-700",
        icon: null,
      };
    default:
      return {
        label: status || "Unknown",
        className: "border-border/70 bg-background/80 text-muted-foreground",
        icon: null,
      };
  }
}

export default function MarketplaceRiaProfilePageClient({
  riaId,
}: {
  riaId: string;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const { activePersona } = usePersonaState();
  const [profile, setProfile] = useState<MarketplaceRia | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const trackedProfileViewRef = useRef(false);
  const firmNames = Array.isArray(profile?.firms)
    ? profile.firms
        .map((firm) => String(firm?.legal_name || "").trim())
        .filter(Boolean)
        .join(" · ")
    : "";

  useEffect(() => {
    let cancelled = false;
    trackedProfileViewRef.current = false;

    async function load() {
      if (!riaId) {
        setProfile(null);
        setError("Missing RIA profile identifier.");
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);
        const next = await RiaService.getRiaPublicProfile(riaId);
        if (!cancelled) {
          setProfile(next);
          if (!trackedProfileViewRef.current) {
            trackedProfileViewRef.current = true;
            trackEvent("marketplace_profile_viewed", {
              action: "ria",
              result: "success",
            });
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          setProfile(null);
          setError(loadError instanceof Error ? loadError.message : "Failed to load RIA profile");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [riaId]);

  async function requestAdvisory() {
    if (!user || !profile) return;
    try {
      setActionLoading(true);
      const idToken = await user.getIdToken();
      await ConsentCenterService.createRequest({
        idToken,
        userId: user.uid,
        payload: {
          subject_user_id: profile.user_id,
          requester_actor_type: "investor",
          subject_actor_type: "ria",
          scope_template_id: "investor_advisor_disclosure_v1",
          duration_mode: "preset",
          duration_hours: 168,
        },
      });
      toast.success("Advisory request sent", {
        description: "The advisor can review it in their pending connections.",
      });
      router.push(buildMarketplaceConnectionsRoute({ tab: "pending" }));
    } catch (requestError) {
      toast.error(
        requestError instanceof Error ? requestError.message : "Failed to send advisory request"
      );
    } finally {
      setActionLoading(false);
    }
  }

  const badge = profile ? verificationBadge(profile.verification_status) : null;
  const BadgeIcon = badge?.icon ?? null;
  const isConnectable = profile
    ? ["active", "verified", "finra_verified", "bypassed"].includes(
        profile.verification_status.toLowerCase()
      )
    : false;
  const voiceSurfaceMetadata = useMemo(
    () => ({
      screenId: "marketplace_ria_profile",
      title: profile?.display_name || "Marketplace RIA Profile",
      purpose: "Public advisor marketplace profile with consent-gated request action.",
      primaryEntity: profile?.display_name || riaId,
      controls: [
        {
          id: "marketplace_ria_profile_route",
          label: "Marketplace RIA profile",
          type: "route",
          actionId: "route.marketplace_ria_profile",
        },
        {
          id: "marketplace_ria_request_advisory",
          label: "Request advisory",
          type: "button",
          state: activePersona === "investor" && isConnectable ? "available" : "hidden",
          actionId: "marketplace.ria.request_advisory",
        },
        {
          id: "marketplace_ria_manage_profile",
          label: "Manage your profile",
          type: "link",
          state: activePersona === "ria" ? "available" : "hidden",
          actionId: "marketplace.ria.manage_profile",
        },
        {
          id: "marketplace_ria_continue_browsing",
          label: "Continue browsing",
          type: "link",
          actionId: "route.marketplace_browse_from_ria_profile",
        },
        {
          id: "marketplace_ria_public_disclosure",
          label: "Public disclosure",
          type: "external_link",
          state: profile?.disclosures_url ? "available" : "hidden",
          actionId: "marketplace.ria.open_public_disclosure",
        },
      ],
      visibleModules: ["Verification", "Firms", "Strategy summary", "Profile actions"],
      selectedEntity: profile?.display_name || riaId,
      busyOperations: actionLoading ? ["marketplace_ria_requesting_advisory"] : [],
      screenMetadata: {
        ria_id: riaId,
        profile_loaded: Boolean(profile),
        active_persona: activePersona,
        is_connectable: isConnectable,
        verification_status: profile?.verification_status || null,
      },
    }),
    [actionLoading, activePersona, isConnectable, profile, riaId]
  );
  usePublishVoiceSurfaceMetadata(voiceSurfaceMetadata);

  return (
    <RiaPageShell
      eyebrow="Marketplace Profile"
      title={profile?.display_name || "RIA profile"}
      description={
        profile?.headline ||
        "Verified public profile metadata only. Private advisory access stays behind the consent boundary."
      }
      nativeTest={{
        routeId: "/marketplace/ria",
        marker: "native-route-marketplace-ria",
        authState: user ? "authenticated" : "pending",
        dataState: loading ? "loading" : profile ? "loaded" : "empty-valid",
        errorCode: error ? "marketplace_ria" : null,
        errorMessage: error,
      }}
      actions={
        <Link
          href={ROUTES.MARKETPLACE}
          data-voice-control-id="marketplace_ria_back_to_marketplace"
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background/60 px-4 text-sm font-medium text-foreground"
        >
          Back to marketplace
        </Link>
      }
    >
      {loading ? <p className="text-sm text-muted-foreground">Loading profile…</p> : null}
      {error ? (
        <RiaSurface className="border-red-500/30 bg-red-500/5">
          <p className="text-sm text-red-400">{error}</p>
        </RiaSurface>
      ) : null}

      {profile ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <RiaSurface className="p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Verification
              </p>
              <div className="mt-2 flex items-center gap-2">
                {BadgeIcon ? <BadgeIcon className="h-4 w-4 text-emerald-600" /> : null}
                <span
                  className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.14em] ${badge?.className}`}
                >
                  {badge?.label}
                </span>
              </div>
            </RiaSurface>
            <RiaSurface className="p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Firms</p>
              <div className="mt-2 flex items-center gap-2">
                {firmNames ? <Building2 className="h-4 w-4 text-muted-foreground" /> : null}
                <p className="text-sm font-medium text-foreground">
                  {firmNames || "No public firm data"}
                </p>
              </div>
            </RiaSurface>
            <RiaSurface className="p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Discoverability
              </p>
              <p className="mt-2 text-sm font-medium text-foreground">
                Public metadata only
              </p>
            </RiaSurface>
          </div>

          <RiaSurface>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Strategy summary
            </p>
            <p className="mt-3 text-sm leading-7 text-foreground">
              {profile.strategy_summary || profile.strategy || "No public strategy summary provided."}
            </p>
          </RiaSurface>

          <RiaSurface>
            <div className="flex flex-wrap gap-3">
              {activePersona === "investor" && isConnectable ? (
                <button
                  type="button"
                  data-voice-control-id="marketplace_ria_request_advisory"
                  className="inline-flex min-h-11 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background disabled:opacity-50"
                  onClick={() => void requestAdvisory()}
                  disabled={actionLoading}
                >
                  {actionLoading ? "Sending request..." : "Request advisory"}
                </button>
              ) : null}
              {activePersona === "ria" ? (
                <Link
                  href={ROUTES.RIA_SETTINGS}
                  data-voice-control-id="marketplace_ria_manage_profile"
                  className="inline-flex min-h-11 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background"
                >
                  Manage your profile
                </Link>
              ) : null}
              <Link
                href={ROUTES.MARKETPLACE}
                data-voice-control-id="marketplace_ria_continue_browsing"
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground"
              >
                Continue browsing
              </Link>
              {profile.disclosures_url ? (
                <a
                  href={profile.disclosures_url}
                  target="_blank"
                  rel="noreferrer"
                  data-voice-control-id="marketplace_ria_public_disclosure"
                  className="inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground"
                >
                  Public disclosure
                </a>
              ) : null}
            </div>
          </RiaSurface>
        </>
      ) : null}
    </RiaPageShell>
  );
}
