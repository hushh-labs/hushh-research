"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
 * The live chip over the map, and the tone that sits on it.
 *
 * `success`, not `action`. The chip reports a settled fact -- this location is
 * updating -- and green is the colour this app has always given that; it also
 * stops the chip from following the accent preference, which had it rendering
 * gold on one account and blue on another for a state that is not a choice.
 * Solid rather than the tint wash: it sits on map tiles it cannot predict, and
 * a 10%-alpha fill leaves its label unreadable over dark satellite imagery.
 */
const LIVE_CHIP = roleSolid("success");

/**
 * How close to expiry the window starts reading as urgent rather than routine.
 * Fifteen minutes is the shortest span in which a recipient can still act on a
 * location — drive to it, or ask for a fresh link — so it is the point where
 * the badge stops being informational and starts being a warning.
 */
const EXPIRING_SOON_MS = 15 * 60 * 1000;

/**
 * How often this page re-reads the link while it is live.
 *
 * The owner publishes their position onto the link every
 * `LIVE_LOCATION_UPDATE_INTERVAL_MS` (20s) while their app is in the
 * foreground. Reading a little faster than that keeps the lag under one
 * publish without asking for points that do not exist yet.
 */
const LIVE_VIEW_POLL_INTERVAL_MS = 15_000;

/**
 * How far the pin has to move before the map is re-pointed at it.
 *
 * The map is a Google embed in an iframe: changing its `src` reloads the
 * frame. A stationary phone still reports a slightly different fix every
 * poll, so re-pointing on any change would flicker the map every fifteen
 * seconds while nobody was going anywhere. Matches the movement threshold the
 * owner's own publisher uses (`LIVE_LOCATION_MIN_MOVE_METERS`), so the two
 * sides agree on what counts as having moved. The "Updated ..." line under
 * the map is not gated on this -- it tells the truth on every poll.
 */
const MAP_RECENTER_MIN_MOVE_METERS = 25;

function metersBetween(
  from: PlainLocationPoint,
  to: PlainLocationPoint,
): number {
  const earthRadiusM = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(a)));
}

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

/**
 * The sharer's name, or "" when the server had nothing real to hand over.
 *
 * `PUBLIC_INVITE_DEFAULT_OWNER_LABEL` on the server is a sentence fragment
 * ("A trusted person") that reads correctly mid-sentence and wrongly anywhere
 * a name belongs -- "A trusted person's live location". Callers that want a
 * name ask for one here and fall back on their own terms; callers that want a
 * sentence use `invite.ownerLabel` directly.
 */
function ownerNameOf(invite: OneLocationPublicInvite | null): string {
  const label = String(invite?.ownerLabel || "").trim();
  if (!label || label.toLowerCase() === "a trusted person") return "";
  return label;
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

function PublicLocationMap({
  point,
  ownerName,
}: {
  point: PlainLocationPoint;
  ownerName: string;
}) {
  const [viewportResetKey, setViewportResetKey] = useState(0);
  // The point the iframe is currently aimed at, which lags the reported point
  // until the reported one has actually gone somewhere.
  const [mapPoint, setMapPoint] = useState(point);
  useEffect(() => {
    setMapPoint((current) =>
      metersBetween(current, point) >= MAP_RECENTER_MIN_MOVE_METERS
        ? point
        : current,
    );
  }, [point]);
  const capturedAt = formatDateTime(point.capturedAt);
  const accuracy =
    typeof point.accuracyM === "number" && Number.isFinite(point.accuracyM)
      ? `Accuracy +/- ${Math.round(point.accuracyM)} m`
      : null;
  return (
    <div className="overflow-hidden rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-default-solid)]">
      <div className="relative h-64 overflow-hidden bg-muted sm:h-72">
        <iframe
          key={`live-location-map:${viewportResetKey}`}
          title="Live location map"
          src={googleMapsEmbedUrl(mapPoint)}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
          className="h-full w-full border-0"
        />
        <div
          // No backdrop blur: the fill is opaque, so there is nothing behind it
          // to blur, and a solid pill is what stays legible over map imagery
          // this page cannot predict.
          className={`pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${LIVE_CHIP.fill} ${LIVE_CHIP.fg}`}
        >
          {/* Same foreground as the label beside it: the live dot reads as
              part of the chip, not as a second location colour. */}
          <span className="h-2 w-2 rounded-full bg-current motion-safe:animate-pulse" />
          <Footnote as="span" className="font-semibold">
            {/* "Public location" described who could open the link. The person
                reading it has already opened it, and what they need to know is
                whether the pin moves. */}
            Live
          </Footnote>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Recenter live location map"
          title="Recenter map"
          onClick={() => setViewportResetKey((current) => current + 1)}
          className="absolute right-3 top-3 z-10 h-11 w-11 rounded-full border border-border/70 bg-background/90 shadow-none backdrop-blur-xl hover:bg-background sm:h-9 sm:w-9"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="space-y-3 p-3.5">
        <div className="min-w-0">
          <CardTitle as="p">
            {ownerName ? `${ownerName}'s location` : "Shared location"}
          </CardTitle>
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
 * Compact reassurance shown on public shared-location links.
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
          This link shows a location, who shared it, and when it expires.
        </LegalText>
      </div>
    </footer>
  );
}

export default function PublicLocationViewPageClient() {
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
  /**
   * Expiry the SERVER agreed to, not the one this browser's clock believes.
   *
   * A window that closes while the tab is open has to take the location with
   * it — nobody reloads a map they are already looking at, and leaving it on
   * screen means the link outlives its own expiry for as long as the tab does.
   * But the countdown is `expiresAt - Date.now()`, and a device whose clock
   * runs a few minutes fast would reach zero while the server was still
   * happily serving the link. That reads exactly like the reported bug: a link
   * created for an hour, gone early, for no reason the person can see.
   *
   * So the countdown hitting zero asks rather than concludes. Only a link the
   * server refuses — or one whose server-sent window really is behind us — is
   * taken off screen.
   */
  const [confirmedExpired, setConfirmedExpired] = useState(false);

  const ownerName = ownerNameOf(invite);
  const remainingMs = useRemainingMs(invite?.expiresAt);
  const countdownLifecycle = lifecycleFor(remainingMs);
  const expiredWhileOpen = confirmedExpired;
  // While the confirmation is in flight the badge says "Checking link" rather
  // than announcing an expiry the map beneath it has not acted on yet.
  const lifecycle: LinkLifecycle = confirmedExpired
    ? "expired"
    : countdownLifecycle === "expired"
      ? "unknown"
      : countdownLifecycle;

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
    ? "Checking this live location link."
    : error
      ? error
      : expiredWhileOpen
        ? `${ownerName || "The sender"} stopped sharing. Ask them for a fresh link.`
        : showLocation
          ? `${ownerName || "A trusted person"} is sharing their live location with you.`
          : `${ownerName || "The sender"} shared this link, but no location is attached to it yet.`;

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
              : "This live location link is unavailable.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (publicToken) {
      void loadInvite();
    } else {
      setError("This live location link is invalid.");
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [publicToken]);

  /**
   * Keep the pin current for as long as the link is.
   *
   * The page used to read the link exactly once, on mount, so what it showed
   * was wherever the sender had been at the moment they pressed Share —
   * presented, for the next hour, as where they are. The owner's app now
   * publishes their position onto the link while it is live; this is the half
   * that puts it on screen.
   *
   * Skipped while the tab is hidden: a backgrounded tab watching a map nobody
   * is looking at is a request the person did not ask for. The next visible
   * tick catches up in one read.
   */
  const hasInvite = Boolean(invite);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!publicToken || !hasInvite || confirmedExpired) return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      try {
        const response =
          await OneLocationService.resolvePublicInvite(publicToken);
        if (cancelled) return;
        setInvite(response.invite);
        setPublicLocation(response.publicLocation ?? null);
      } catch {
        // A poll failing is not news. It is usually a dropped connection, and
        // the terminal states — expiry and revocation — are owned by the
        // confirmation below, which asks the same question deliberately.
      }
    };

    const interval = window.setInterval(
      () => void poll(),
      LIVE_VIEW_POLL_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [confirmedExpired, hasInvite, publicToken]);

  /**
   * The countdown reaching zero asks the server, rather than concluding.
   *
   * If the link resolves and its window is still ahead of us, this browser's
   * clock was fast: adopt the server's `expiresAt` and carry on watching. Only
   * a refusal — or a window the server itself puts behind us — takes the
   * location off screen.
   */
  const countdownExpired = countdownLifecycle === "expired";
  const confirmExpiry = useCallback(async () => {
    try {
      const response =
        await OneLocationService.resolvePublicInvite(publicToken);
      const serverExpiryMs = new Date(
        response.invite?.expiresAt || "",
      ).getTime();
      if (Number.isFinite(serverExpiryMs) && serverExpiryMs > Date.now()) {
        setInvite(response.invite);
        setPublicLocation(response.publicLocation ?? null);
        return;
      }
      setConfirmedExpired(true);
    } catch {
      setConfirmedExpired(true);
    }
  }, [publicToken]);

  useEffect(() => {
    if (!publicToken || !hasInvite) return;
    if (!countdownExpired || confirmedExpired) return;
    void confirmExpiry();
  }, [
    confirmExpiry,
    confirmedExpired,
    countdownExpired,
    hasInvite,
    publicToken,
  ]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[720px] flex-col px-5 pb-10 pt-[max(48px,calc(env(safe-area-inset-top)+28px))] sm:px-6 sm:pt-[max(64px,calc(env(safe-area-inset-top)+40px))]">
        <div className="rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-none sm:p-6">
          <div className="space-y-6">
            <div>
              <SectionLabel>Live location</SectionLabel>
              <div className="mt-2 flex items-center gap-3">
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
                <AgentTitle>
                  {ownerName ? `${ownerName}'s live location` : "Shared location"}
                </AgentTitle>
              </div>
              <div className="min-w-0">
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
                  <PublicLocationMap
                    point={publicLocation}
                    ownerName={ownerName}
                  />
                ) : (
                  <div
                    className={`rounded-[var(--app-card-radius-compact)] p-4 ${NO_SNAPSHOT_TONE.tile} ${NO_SNAPSHOT_TONE.glyph}`}
                  >
                    <BodyText>
                      {expiredWhileOpen
                        ? "The viewing window closed, so the location is no longer shown. Ask the sender to share a fresh live location link."
                        : "This link opened correctly, but no live location is attached to it. Ask the sender to share a fresh live location link."}
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
