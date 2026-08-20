"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  MapPin,
  RefreshCw,
  Route,
  ShieldCheck,
} from "lucide-react";


import { driveEtaText } from "@/app/one/location/drive-eta";
import {
  AgentTitle,
  BodyText,
  CardTitle,
  Footnote,
  LegalText,
  RowDescription,
  SectionLabel,
} from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  roleClasses,
  roleSolid,
  type SemanticRole,
} from "@/lib/morphy-ux/tokens/semantic-roles";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationPublicInvite,
  PlainLocationPoint,
} from "@/lib/one-location/types";

/**
 * The link resolved and the window is open — there is simply no snapshot on
 * it yet. That is an empty state, not a failure, so it takes the resting
 * neutral rather than the warning family it used to borrow. It also has to
 * agree with the header bubble above it, which reports the same state.
 */
const NO_SNAPSHOT_TONE = roleClasses("neutral");

/**
 * Anything sitting ON the solid accent chip over the map. Hard-coded white
 * stops being readable the moment the accent preference switches to gold;
 * this is the accent's own declared foreground.
 */
const ON_ACCENT_FG = roleSolid("action").fg;

/**
 * How close to expiry the window starts reading as urgent rather than routine.
 * Fifteen minutes is the shortest span in which a recipient can still act on a
 * location — drive to it, or ask for a fresh link — so it is the point where
 * the badge stops being informational and starts being a warning.
 */
const EXPIRING_SOON_MS = 15 * 60 * 1000;

type LinkLifecycle = "active" | "expiring" | "expired" | "unknown";

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

/**
 * Coarse above an hour, precise below it. A recipient reading "2h 14m" does not
 * need the seconds, but one reading "40s" is deciding whether to keep the tab
 * open, and a minutes-only countdown would sit on "0m" for a full minute while
 * the link was still live.
 */
function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Milliseconds left on the window, re-read every second.
 *
 * Deliberately null until after mount: the value depends on the reader's clock,
 * and rendering it during SSR would produce markup the client immediately
 * contradicts. Callers treat null as "not known yet" rather than "expired".
 */
function useRemainingMs(expiresAt?: string | null): number | null {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      setRemainingMs(null);
      return;
    }
    const expiryMs = new Date(expiresAt).getTime();
    if (Number.isNaN(expiryMs)) {
      setRemainingMs(null);
      return;
    }
    const tick = () => setRemainingMs(expiryMs - Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  return remainingMs;
}

function lifecycleFor(remainingMs: number | null): LinkLifecycle {
  if (remainingMs === null) return "unknown";
  if (remainingMs <= 0) return "expired";
  if (remainingMs <= EXPIRING_SOON_MS) return "expiring";
  return "active";
}

const LIFECYCLE_ROLE: Record<LinkLifecycle, SemanticRole> = {
  active: "success",
  expiring: "warning",
  expired: "danger",
  unknown: "neutral",
};

/**
 * The window's state as one badge, rather than the two flat chips that used to
 * report an absolute timestamp and a duration the reader had to subtract for
 * themselves.
 */
function LinkStatusBadge({
  lifecycle,
  remainingMs,
  expiresAt,
}: {
  lifecycle: LinkLifecycle;
  remainingMs: number | null;
  expiresAt?: string | null;
}) {
  const tone = roleClasses(LIFECYCLE_ROLE[lifecycle]);
  const live = lifecycle === "active" || lifecycle === "expiring";
  const label =
    lifecycle === "expired"
      ? "Link expired"
      : remainingMs === null
        ? "Checking link"
        : `Expires in ${formatRemaining(remainingMs)}`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${tone.tile} ${tone.glyph}`}
        // The countdown rewrites itself every second. Announcing each tick
        // would make the badge unusable with a screen reader, so the live
        // region is off and the absolute expiry beside it carries the same
        // fact in a form that does not move.
        aria-live="off"
      >
        {live ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-current motion-safe:animate-pulse"
            aria-hidden="true"
          />
        ) : null}
        <Footnote as="span" className="font-semibold">
          {label}
        </Footnote>
      </span>
      {lifecycle === "expired" ? null : (
        <RowDescription as="span">
          {formatDateTime(expiresAt)}
        </RowDescription>
      )}
    </div>
  );
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
        <div
          className={`pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2 rounded-full bg-[color:var(--app-accent)]/80 px-3 py-1.5 backdrop-blur-xl ${ON_ACCENT_FG}`}
        >
          {/* Same foreground as the label beside it: the live dot reads as
              part of the chip, not as a second (cyan) location colour. */}
          <span className="h-2 w-2 rounded-full bg-[color:var(--app-accent-fg)] motion-safe:animate-pulse" />
          <Footnote as="span" className="font-semibold">
            Public location
          </Footnote>
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
          <CardTitle as="p">Shared location</CardTitle>
          <RowDescription className="mt-0.5">
            Updated {capturedAt}
            {accuracy ? ` - ${accuracy}` : ""}
          </RowDescription>
        </div>
        {point.drive ? (
          <div className="rounded-[12px] bg-[color:var(--app-accent-tint)] p-3">
            <Footnote
              as="p"
              className="flex items-center gap-1.5 font-semibold text-[color:var(--app-accent)]"
            >
              <Route className="h-3.5 w-3.5" aria-hidden="true" />
              Driving to {point.drive.destination.label}
            </Footnote>
            <BodyText className="mt-0.5 font-semibold">
              {driveEtaText(point.drive.etaSeconds)}
            </BodyText>
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

/**
 * What this link does and does not carry, said to the person holding it.
 *
 * The privacy sentence is an assertion about `_public_invite_payload(public=True)`
 * in `one_location_agent_service.py`, which returns status, duration, expiry and
 * a fixed "A trusted person" label — never the owner's id, name, phone or email.
 * If that payload ever gains an identity field, this sentence stops being true
 * and must change with it.
 */
function TrustFooter() {
  return (
    <footer className="mt-6 flex items-start gap-3 border-t border-border/60 pt-5">
      <ShieldCheck
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-1">
        <Footnote className="font-semibold">Shared securely through Hussh</Footnote>
        <LegalText as="p">
          This link shows a location and when it expires. It does not reveal the
          sender&apos;s name, phone number, or email address, and it stops
          working once the window closes.
        </LegalText>
      </div>
    </footer>
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

  const remainingMs = useRemainingMs(invite?.expiresAt);
  const lifecycle = lifecycleFor(remainingMs);
  const expiredWhileOpen = lifecycle === "expired";

  /**
   * A window that closes while the tab is open has to take the location with
   * it. The server refuses an expired token, so a reload would show nothing —
   * but nobody reloads a map they are already looking at, and leaving it on
   * screen means the link outlives its own expiry for as long as the tab does.
   */
  const showLocation = Boolean(publicLocation) && !expiredWhileOpen;

  // Three opposite states shared one action-blue bubble, so an unusable link
  // was painted the same colour as a working one and only the glyph told the
  // truth. The glyph stays exactly as it is; the bubble now agrees with it.
  // No snapshot (and the checking-the-link moment) is an empty state, not an
  // action and not a failure — it rests on neutral.
  const headerRole: SemanticRole = error
    ? "danger"
    : expiredWhileOpen
      ? "danger"
      : showLocation
        ? "success"
        : "neutral";
  const headerTone = roleClasses(headerRole);

  const headline = loading
    ? "Checking public location link."
    : error
      ? error
      : expiredWhileOpen
        ? "This public location link has expired. Ask the sender for a fresh one."
        : showLocation
          ? `${invite?.ownerLabel || "A trusted person"} shared this public location with you.`
          : "This public link is active, but no location snapshot is attached.";

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
        <div className="rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-none sm:p-6">
          <div className="space-y-6">
            <div className="flex items-start gap-4">
              <div
                className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] ${headerTone.tile} ${headerTone.glyph}`}
              >
                {error || expiredWhileOpen ? (
                  <AlertTriangle className="h-[17px] w-[17px]" aria-hidden="true" />
                ) : showLocation ? (
                  <CheckCircle2 className="h-[17px] w-[17px]" aria-hidden="true" />
                ) : (
                  <MapPin className="h-[17px] w-[17px]" aria-hidden="true" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <SectionLabel>Location</SectionLabel>
                <AgentTitle className="mt-1">View shared location</AgentTitle>
                <BodyText className="mt-3 text-muted-foreground">
                  {headline}
                </BodyText>
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
                <LinkStatusBadge
                  lifecycle={lifecycle}
                  remainingMs={remainingMs}
                  expiresAt={invite.expiresAt}
                />
                {showLocation && publicLocation ? (
                  <PublicLocationMap point={publicLocation} />
                ) : (
                  <div
                    className={`rounded-[var(--app-card-radius-compact)] p-4 ${NO_SNAPSHOT_TONE.tile} ${NO_SNAPSHOT_TONE.glyph}`}
                  >
                    <BodyText>
                      {expiredWhileOpen
                        ? "The viewing window closed, so the location is no longer shown. Ask the sender to create a fresh public location link."
                        : "This link opened correctly, but no public location is attached. Ask the sender to create a fresh public location link."}
                    </BodyText>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <TrustFooter />
        </div>
      </div>
    </main>
  );
}
