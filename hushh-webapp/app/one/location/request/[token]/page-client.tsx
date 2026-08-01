"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, MapPin, Route } from "lucide-react";

import { driveEtaText } from "@/app/one/location/drive-eta";
import { LiveMap } from "@/components/one-location/live-map";
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

function googleMapsDirectionsUrl(point: PlainLocationPoint): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    coordinateQuery(point),
  )}&travelmode=driving`;
}

function PublicLocationMap({ point }: { point: PlainLocationPoint }) {
  const approximate = point.locationMode === "approximate";
  const capturedAt = formatDateTime(point.capturedAt);
  const accuracy =
    typeof point.accuracyM === "number" && Number.isFinite(point.accuracyM)
      ? `Accuracy +/- ${Math.round(point.accuracyM)} m`
      : null;
  return (
    <div className="overflow-hidden rounded-[var(--app-card-radius-standard)] border border-border/70 bg-background">
      <div className="relative h-64 overflow-hidden bg-muted">
        <LiveMap
          point={point}
          mode={approximate ? "approximate" : "precise"}
          approximateRadiusM={point.approximateRadiusM ?? undefined}
          title="Public location map"
        />
        <div className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3 py-1.5 text-xs font-semibold text-foreground shadow-lg backdrop-blur-xl">
          <span className="h-2 w-2 rounded-full bg-[color:var(--app-accent)]" />
          {approximate ? "Approximate area" : "Precise location"}
        </div>
      </div>
      <div className="space-y-3 p-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {approximate
              ? "Shared approximate area"
              : "Shared precise location"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Snapshot captured {capturedAt}
            {approximate && point.approximateRadiusM
              ? ` - about ${Math.round(point.approximateRadiusM / 100) / 10} km radius`
              : accuracy
                ? ` - ${accuracy}`
                : ""}
          </p>
        </div>
        {point.drive ? (
          <div className="rounded-[12px] border border-sky-500/30 bg-sky-500/[0.08] p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
              <Route className="h-3.5 w-3.5" aria-hidden="true" />
              Driving to {point.drive.destination.label}
            </p>
            <p className="mt-0.5 text-sm font-semibold">
              {driveEtaText(point.drive.etaSeconds)}
            </p>
          </div>
        ) : null}
        {!approximate ? (
          <div className="grid gap-2">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-10 rounded-full"
            >
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
        ) : (
          <p className="rounded-xl bg-[color:var(--app-accent-tint)] p-3 text-xs leading-5 text-muted-foreground">
            The sender shared only a general area. Their exact position and
            turn-by-turn directions stay private.
          </p>
        )}
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
      <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-5 py-10">
        <div className="space-y-6 rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-[var(--shadow-xs)] sm:p-7">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
              {error ? (
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              ) : publicLocation ? (
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              ) : (
                <MapPin className="h-5 w-5" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--app-accent)]">
                Location
              </div>
              <h1 className="mt-2 text-[28px] font-medium leading-[1.12] tracking-normal sm:text-[32px]">
                View shared location
              </h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {loading
                  ? "Checking public location link."
                  : error
                    ? error
                    : publicLocation
                      ? `${ownerLabel(invite)} shared a location snapshot with you.`
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
              <div className="flex flex-wrap items-center gap-2 text-sm">
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
                <div className="rounded-[var(--app-card-radius-standard)] border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-800 dark:text-amber-100">
                  This link opened correctly, but no public location is
                  attached. Ask the sender to create a fresh public location
                  link.
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
