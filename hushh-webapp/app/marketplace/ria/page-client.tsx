"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { RiaPageShell, RiaSurface } from "@/components/ria/ria-page-shell";
import { ROUTES } from "@/lib/navigation/routes";
import { RiaService, type MarketplaceRia } from "@/lib/services/ria-service";

export default function MarketplaceRiaProfilePageClient({
  riaId,
}: {
  riaId: string;
}) {
  const [profile, setProfile] = useState<MarketplaceRia | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const firmNames = Array.isArray(profile?.firms)
    ? profile.firms
        .map((firm) => String(firm?.legal_name || "").trim())
        .filter(Boolean)
        .join(" · ")
    : "";

  useEffect(() => {
    let cancelled = false;

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
        if (!cancelled) setProfile(next);
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
        authState: "authenticated",
        dataState: loading ? "loading" : profile ? "loaded" : "empty-valid",
        errorCode: error ? "marketplace_ria" : null,
        errorMessage: error,
      }}
      actions={
        <Link
          href={ROUTES.MARKETPLACE}
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
              <p className="mt-2 text-xl font-semibold text-foreground">
                {profile.verification_status}
              </p>
            </RiaSurface>
            <RiaSurface className="p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Firms</p>
              <p className="mt-2 text-sm font-medium text-foreground">
                {firmNames || "No public firm data"}
              </p>
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
              <Link
                href={ROUTES.MARKETPLACE}
                className="inline-flex min-h-11 items-center justify-center rounded-full bg-foreground px-4 text-sm font-medium text-background"
              >
                Continue browsing
              </Link>
              <Link
                href={ROUTES.KAI_HOME}
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground"
              >
                Return to Kai
              </Link>
            </div>
          </RiaSurface>
        </>
      ) : null}
    </RiaPageShell>
  );
}
