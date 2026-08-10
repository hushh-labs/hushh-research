"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  MapPin,
  RefreshCw,
  Route,
} from "lucide-react";


import { driveEtaText } from "@/app/one/location/drive-eta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationPublicInvite,
  PlainLocationPoint,
} from "@/lib/one-location/types";

function formatDateTime(value?: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function ownerLabel(invite: OneLocationPublicInvite | null): string {
  return invite?.ownerLabel || "a trusted person";
}

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : "0.000000";
}

function coordinateQuery(point: PlainLocationPoint): string {
  return `${formatCoordinate(point.latitude)},${formatCoordinate(point.longitude)}`;
}

function googleMapsEmbedUrl(point: PlainLocationPoint): string {
  return `https://www.google.com/maps?q=${encodeURIComponent(coordinateQuery(point))}&z=16&output=embed`;
}

function googleMapsDirectionsUrl(point: PlainLocationPoint): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    coordinateQuery(point),
  )}&travelmode=driving`;
}

function PublicLocationMap({ point }: { point: PlainLocationPoint }) {
  const [viewportResetKey, setViewportResetKey] = useState(0);
  const capturedAt = formatDateTime(point.capturedAt);
  const accuracy =
    typeof point.accuracyM === "number" && Number.isFinite(point.accuracyM)
      ? `Accuracy +/- ${Math.round(point.accuracyM)} m`
      : null;
  return (
    <div className="overflow-hidden rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-default-solid)]">
      <div className="relative h-64 overflow-hidden bg-muted sm:h-72">
        <iframe
          key={`public-location-map:${viewportResetKey}`}
          title="Public location map"
          src={googleMapsEmbedUrl(point)}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
          className="h-full w-full border-0"
        />
        <div className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2 rounded-full bg-[color:var(--app-success)] px-3 py-1.5 text-[12px] font-semibold leading-4 text-white backdrop-blur-xl">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
          Public location
        </div>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Recenter public location map"
          title="Recenter map"
          onClick={() => setViewportResetKey((current) => current + 1)}
          className="absolute right-3 top-3 z-10 h-11 w-11 rounded-full border border-border/70 bg-background/90 shadow-none backdrop-blur-xl hover:bg-background sm:h-9 sm:w-9"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="space-y-3 p-3.5">
        <div className="min-w-0">
          <p className="text-[17px] font-normal leading-[22px]">Shared location</p>
          <p className="mt-0.5 text-[15px] leading-5 text-muted-foreground">
            Updated {capturedAt}
            {accuracy ? ` - ${accuracy}` : ""}
          </p>
        </div>
        {point.drive ? (
          <div className="rounded-[12px] bg-[color:var(--app-accent)]/10 p-3">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold leading-[18px] text-[color:var(--app-accent)]">
              <Route className="h-3.5 w-3.5" aria-hidden="true" />
              Driving to {point.drive.destination.label}
            </p>
            <p className="mt-0.5 text-[15px] font-semibold leading-5">
              {driveEtaText(point.drive.etaSeconds)}
            </p>
          </div>
        ) : null}
        <div className="grid gap-2">
          <Button asChild variant="outline" size="sm" className="h-10 rounded-full">
            <a
              href={googleMapsDirectionsUrl(point)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Route className="h-4 w-4" aria-hidden="true" />
              Directions
            </a>
          </Button>
        </div>

      </div>
    </div>
  );
}

export default function PublicLocationRequestPageClient() {
  const params = useParams<{ token?: string }>();
  const publicToken = useMemo(
    () => String(params?.token || "").trim(),
    [params?.token],
  );
  const [invite, setInvite] = useState<OneLocationPublicInvite | null>(null);
  const [publicLocation, setPublicLocation] =
    useState<PlainLocationPoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadInvite = async () => {
      setLoading(true);
      setError(null);
      try {
        const response =
          await OneLocationService.resolvePublicInvite(publicToken);
        if (!cancelled) {
          setInvite(response.invite);
          setPublicLocation(response.publicLocation ?? null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "This public location link is unavailable.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (publicToken) {
      void loadInvite();
    } else {
      setError("This public location link is invalid.");
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [publicToken]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[720px] flex-col px-5 pb-10 pt-[max(48px,calc(env(safe-area-inset-top)+28px))] sm:px-6 sm:pt-[max(64px,calc(env(safe-area-inset-top)+40px))]">
        <div className="space-y-6 rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-none sm:p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)]">
              {error ? (
                <AlertTriangle className="h-[17px] w-[17px]" aria-hidden="true" />
              ) : publicLocation ? (
                <CheckCircle2 className="h-[17px] w-[17px]" aria-hidden="true" />
              ) : (
                <MapPin className="h-[17px] w-[17px]" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                Location
              </div>
              <h1 className="mt-1 text-[32px] font-bold leading-[1.08] tracking-normal sm:text-[34px]">
                View shared location
              </h1>
              <p className="mt-3 text-[17px] leading-[24px] text-muted-foreground">
                {loading
                  ? "Checking public location link."
                  : error
                    ? error
                    : publicLocation
                      ? `${ownerLabel(invite)} shared this public location with you.`
                      : "This public link is active, but no location snapshot is attached."}
              </p>
            </div>
          </div>

          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-11 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-10 w-36 rounded-xl" />
            </div>
          ) : null}

          {!loading && invite ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <Badge variant="secondary">
                  Expires {formatDateTime(invite.expiresAt)}
                </Badge>
                <Badge variant="outline">
                  {invite.durationHours}h public viewing window
                </Badge>
              </div>
              {publicLocation ? (
                <PublicLocationMap point={publicLocation} />
              ) : (
                <div className="rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-warning)]/10 p-4 text-[15px] leading-5 text-[color:var(--app-warning)]">
                  This link opened correctly, but no public location is attached.
                  Ask the sender to create a fresh public location link.
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
