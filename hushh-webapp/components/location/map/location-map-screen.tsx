"use client";

/**
 * `/one/location/map` — Your Map, for the voice-first Location area.
 *
 * Composes the existing `LiveMap` renderer (one focused point at a time)
 * with a people tray: everyone whose fresh, authorized private share the
 * server holds, decrypted on this device and kept in memory only
 * (`location-workspace-memory`). Nothing here publishes: the app-level
 * LocationPublisherBridge owns the publish loop. "Locate me" takes one
 * foreground fix from the device and centres the map on it.
 *
 * Coordinates reach the Google renderer only after the owner has accepted the
 * renderer consent the server records in map preferences.
 *
 * The route hides the persistent chrome, so this screen draws its own close
 * control back to Location.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Crosshair,
  Eye,
  EyeOff,
  Loader2,
  MapPin,
  Users,
  X,
} from "@/components/icons";

import { LiveMap } from "@/components/one-location/live-map";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  CARD_SURFACE,
  MUTED_TEXT,
  SUBCARD_SURFACE,
} from "@/lib/morphy-ux/tokens/surfaces";
import {
  AvatarBubble,
  EmptyState,
  StatusPill,
  TaskFlowHeader,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { ROUTES } from "@/lib/navigation/routes";
import { decryptLocationEnvelope } from "@/lib/one-location/encryption";
import { liveFreshness } from "@/lib/one-location/freshness";
import {
  clearLocationWorkspaceMemory,
  readLocationWorkspaceMemory,
  writeLocationWorkspaceMemory,
} from "@/lib/one-location/location-workspace-memory";
import {
  GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
  readCachedRendererConsentAccepted,
  writeCachedRendererConsentAccepted,
} from "@/lib/one-location/map-renderer-consent";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationGrant,
  OneLocationMapPreferences,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { useCurrentLocation } from "@/lib/one-location/use-current-location";
import {
  NOT_SUCCESS_STATUSES,
  type ToolResultPublic,
} from "@/lib/one-voice/protocol";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const SCREEN_ID = "one_location_map";
const VOICE_ACTIONS = deriveLocationVoiceActions(SCREEN_ID);
/** How often the ciphertext inventory is re-read while the screen is visible. */
const MARKER_POLL_MS = 15_000;

const MAP_REFRESH_KEYS = new Set([
  "location_home",
  "location_active_shares",
  "location_shared_with_me",
  "location_map",
]);

export type DecodedMarker = {
  grant: OneLocationGrant;
  point: PlainLocationPoint;
};

export type MapFocus = { kind: "self" } | { kind: "grant"; grantId: string };

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1)
    return (parts[0] ?? "").slice(0, 2).toUpperCase() || "?";
  return (
    `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase() ||
    "?"
  );
}

function ownerName(grant: OneLocationGrant): string {
  return grant.ownerDisplayName?.trim() || "Someone";
}

/** True once the server's map preference records the current renderer consent. */
export function rendererConsentCurrent(
  preferences:
    | Pick<OneLocationMapPreferences, "rendererConsentVersion">
    | null
    | undefined,
): boolean {
  return (
    preferences?.rendererConsentVersion === GOOGLE_MAPS_RENDERER_CONSENT_VERSION
  );
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

export function LocationMapScreen() {
  const router = useRouter();
  const { userId } = useAuth();
  const selfAvatarUrl = useEffectiveAvatarUrl();
  const { vaultOwnerToken } = useVault();
  const device = useCurrentLocation({ auto: false, userId });
  const [preferences, setPreferences] =
    useState<OneLocationMapPreferences | null>(null);
  const [consentAccepted, setConsentAccepted] = useState<boolean>(() =>
    readCachedRendererConsentAccepted(userId),
  );
  const [consentBusy, setConsentBusy] = useState(false);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [markers, setMarkers] = useState<DecodedMarker[]>([]);
  const [freshnessSeconds, setFreshnessSeconds] = useState(120);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus>({ kind: "self" });
  const [viewportResetKey, setViewportResetKey] = useState(0);
  const [locating, setLocating] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [sealedCount, setSealedCount] = useState(0);
  const mountedRef = useRef(true);
  const undecryptableRef = useRef(new Set<string>());
  const consentRef = useRef(consentAccepted);
  consentRef.current = consentAccepted;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  // Decrypted coordinates never outlive this account's screen.
  useEffect(() => {
    return () => {
      clearLocationWorkspaceMemory(userId);
    };
  }, [userId]);

  usePublishVoiceSurfaceMetadata(
    userId
      ? {
          screenId: SCREEN_ID,
          title: "Your Map",
          purpose:
            "Shows where people who share location with you are right now. Locate me centres the map on this device's position.",
          spokenSubject: "Location, Your Map",
          actions: VOICE_ACTIONS,
          availableActions: VOICE_ACTIONS.map((action) => action.label),
          screenMetadata: { people_on_map: markers.length },
        }
      : null,
  );

  const load = useCallback(async () => {
    if (!userId || !vaultOwnerToken) return;
    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const mapState = await OneLocationService.getMapState(vaultOwnerToken);
      if (!mountedRef.current) return;
      setPreferences(mapState.preferences);
      setFreshnessSeconds(
        Math.max(30, Number(mapState.freshnessSeconds) || 120),
      );
      const consentOk =
        rendererConsentCurrent(mapState.preferences) || consentRef.current;
      if (rendererConsentCurrent(mapState.preferences)) {
        setConsentAccepted(true);
        writeCachedRendererConsentAccepted(userId, true);
      }
      const sealed = mapState.markers ?? [];
      setSealedCount(sealed.length);
      if (!consentOk) {
        // Nothing is decrypted until the owner has said yes to the renderer.
        setMarkers([]);
        setError(null);
        setStatus("ready");
        return;
      }
      const decoded: DecodedMarker[] = [];
      for (const marker of sealed) {
        const envelopeId =
          marker.envelope.id ??
          `${marker.grant.id}:${marker.envelope.capturedAt}`;
        if (undecryptableRef.current.has(envelopeId)) continue;
        try {
          const point = await decryptLocationEnvelope({
            userId,
            envelope: marker.envelope,
          });
          decoded.push({ grant: marker.grant, point });
        } catch {
          // A point sealed to a key this device no longer holds. Never shown,
          // never retried on every poll.
          undecryptableRef.current.add(envelopeId);
        }
      }
      if (!mountedRef.current) return;
      setMarkers(decoded);
      const memory = readLocationWorkspaceMemory(userId);
      writeLocationWorkspaceMemory(userId, {
        ...memory,
        decryptedPoints: Object.fromEntries(
          decoded.map((row) => [row.grant.id, row.point]),
        ),
      });
      setError(null);
      setStatus("ready");
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't load the map.",
      );
      setStatus("error");
    }
  }, [userId, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (status !== "ready") return;
    const tick = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      void load();
    };
    const timer = window.setInterval(tick, MARKER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, status]);

  useVoiceToolEffects({
    onToolResult: (_tool, result: ToolResultPublic) => {
      if (NOT_SUCCESS_STATUSES.has(result.status)) return;
      const keys = Array.isArray(result.ui_refresh) ? result.ui_refresh : [];
      if (keys.some((key) => MAP_REFRESH_KEYS.has(String(key)))) void load();
    },
    onPendingResolved: (_id, resolved, result) => {
      if (resolved !== "executed" || !result) return;
      const keys = Array.isArray(result.ui_refresh) ? result.ui_refresh : [];
      if (keys.some((key) => MAP_REFRESH_KEYS.has(String(key)))) void load();
    },
  });

  const acceptRendererConsent = useCallback(async () => {
    if (!vaultOwnerToken || !userId || consentBusy) return;
    setConsentBusy(true);
    try {
      const next = await OneLocationService.updateMapPreferences({
        vaultOwnerToken,
        rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
      });
      if (!mountedRef.current) return;
      setPreferences(next);
      const accepted = rendererConsentCurrent(next);
      consentRef.current = accepted;
      setConsentAccepted(accepted);
      writeCachedRendererConsentAccepted(userId, accepted);
      if (accepted) await load();
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't turn the map on.",
      );
    } finally {
      if (mountedRef.current) setConsentBusy(false);
    }
  }, [consentBusy, load, userId, vaultOwnerToken]);

  const togglePresence = useCallback(async () => {
    if (!vaultOwnerToken || !preferences || presenceBusy) return;
    const nextMode: OneLocationMapPreferences["presenceMode"] =
      preferences.presenceMode === "ghost" ? "foreground_private" : "ghost";
    setPresenceBusy(true);
    try {
      const next = await OneLocationService.updateMapPreferences({
        vaultOwnerToken,
        presenceMode: nextMode,
      });
      if (!mountedRef.current) return;
      setPreferences(next);
      morphyToast.success(
        next.presenceMode === "ghost"
          ? "You're hidden from the map."
          : "You're visible to people you share with.",
      );
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't change map visibility.",
      );
    } finally {
      if (mountedRef.current) setPresenceBusy(false);
    }
  }, [preferences, presenceBusy, vaultOwnerToken]);

  const locateMe = useCallback(async () => {
    if (locating) return;
    setLocating(true);
    try {
      const snapshot = await device.request();
      if (!mountedRef.current) return;
      if (!snapshot) {
        morphyToast.error(
          "Couldn't get your location. Check the device permission.",
        );
        return;
      }
      setFocus({ kind: "self" });
      setViewportResetKey((value) => value + 1);
    } finally {
      if (mountedRef.current) setLocating(false);
    }
  }, [device, locating]);

  const selfPoint = useMemo<PlainLocationPoint | null>(() => {
    const snapshot = device.snapshot;
    if (!snapshot) return null;
    return {
      latitude: snapshot.latitude,
      longitude: snapshot.longitude,
      accuracyM: snapshot.accuracyM,
      capturedAt: snapshot.capturedAt,
      sourcePlatform: snapshot.sourcePlatform ?? "web",
    };
  }, [device.snapshot]);

  const focusedMarker = useMemo(
    () =>
      focus.kind === "grant"
        ? (markers.find((row) => row.grant.id === focus.grantId) ?? null)
        : null,
    [focus, markers],
  );
  const mapPoint: PlainLocationPoint | null =
    focusedMarker?.point ??
    (focus.kind === "self" ? selfPoint : null) ??
    markers[0]?.point ??
    selfPoint;

  const close = useCallback(() => {
    router.replace(ROUTES.ONE_LOCATION, { scroll: false });
  }, [router]);

  const staleMs = freshnessSeconds * 1000;
  const consentReady = consentAccepted || rendererConsentCurrent(preferences);

  return (
    <main
      className="flex min-h-svh flex-col bg-background text-foreground"
      data-testid="one-location-map-screen"
      data-ambient-chrome-ignore
    >
      <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <TaskFlowHeader title="Your Map" />
        <Button
          size="icon-lg"
          variant="outline"
          aria-label="Back to Location"
          onClick={close}
          data-testid="one-location-map-close"
        >
          <X className="h-5 w-5" aria-hidden />
        </Button>
      </header>

      <div
        className="relative min-h-[320px] flex-1"
        data-testid="one-location-map-canvas"
      >
        {consentReady && mapPoint ? (
          <div className="absolute inset-0 overflow-hidden">
            <LiveMap
              point={mapPoint}
              viewportResetKey={viewportResetKey}
              avatarUrl={selfAvatarUrl}
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            {!consentReady ? (
              <div
                className={cn(CARD_SURFACE, "max-w-md space-y-3 p-5")}
                data-testid="map-renderer-consent"
              >
                <p className="ui-text-row-label-emphasized">Show the map?</p>
                <p className={MUTED_TEXT}>
                  Positions are drawn by Google Maps on this device. Only shares
                  you already have permission to see are ever decrypted, and
                  only after you say yes here.
                  {sealedCount
                    ? ` ${sealedCount} ${sealedCount === 1 ? "person is" : "people are"} sharing with you.`
                    : ""}
                </p>
                <Button
                  disabled={consentBusy || !vaultOwnerToken}
                  onClick={() => void acceptRendererConsent()}
                >
                  {consentBusy ? (
                    <Loader2
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                  ) : (
                    <MapPin className="h-4 w-4" aria-hidden />
                  )}
                  Show the map
                </Button>
              </div>
            ) : (
              <EmptyState
                icon={<MapPin className="h-6 w-6" aria-hidden />}
                title="Nothing to show yet"
                description={
                  status === "loading"
                    ? "Loading shares…"
                    : "Tap Locate me to centre on where you are, or wait for someone to share with you."
                }
              />
            )}
          </div>
        )}

        {consentReady ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end p-4">
            <Button
              className="pointer-events-auto"
              variant="outline"
              disabled={locating}
              onClick={() => void locateMe()}
              data-testid="one-location-map-locate"
              aria-label="Locate me"
            >
              {locating ? (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                <Crosshair className="h-4 w-4" aria-hidden />
              )}
              Locate me
            </Button>
          </div>
        ) : null}
      </div>

      <section className="space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {status === "error" ? (
          <p
            className="ui-text-row-description text-[color:var(--app-destructive)]"
            role="alert"
          >
            {error ?? "Couldn't load the map."}
          </p>
        ) : null}

        <div className={cn(SUBCARD_SURFACE, "flex items-center gap-3 p-3")}>
          {preferences?.presenceMode === "foreground_private" ? (
            <Eye
              className="h-4 w-4 shrink-0 text-[color:var(--app-accent)]"
              aria-hidden
            />
          ) : (
            <EyeOff
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="ui-text-row-label-emphasized">
              {preferences === null
                ? "Map visibility"
                : preferences.presenceMode === "foreground_private"
                  ? "Visible to people you share with"
                  : "Hidden from the map"}
            </p>
            <p className={MUTED_TEXT}>
              Your private shares still reach the people they name either way.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={presenceBusy || !preferences || !vaultOwnerToken}
            onClick={() => void togglePresence()}
          >
            {preferences?.presenceMode === "foreground_private"
              ? "Hide me"
              : "Show me"}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3">
          <h2 className="ui-text-section-title">People sharing with you</h2>
          <StatusPill tone={markers.length ? "live" : "neutral"}>
            {markers.length ? `${markers.length} live` : "None"}
          </StatusPill>
        </div>

        {selfPoint ? (
          <button
            type="button"
            onClick={() => {
              setFocus({ kind: "self" });
              setViewportResetKey((value) => value + 1);
            }}
            aria-pressed={focus.kind === "self"}
            className={cn(
              SUBCARD_SURFACE,
              "flex min-h-11 w-full items-center gap-3 p-3 text-left",
              focus.kind === "self" && "ring-2 ring-[color:var(--app-accent)]",
            )}
          >
            <AvatarBubble initials="Me" size={32} />
            <span className="min-w-0 flex-1">
              <span className="ui-text-row-label-emphasized block">You</span>
              <span className={cn(MUTED_TEXT, "block")}>
                {device.snapshotOrigin === "restored"
                  ? "Last known position"
                  : "This device"}
              </span>
            </span>
          </button>
        ) : null}

        {markers.length ? (
          <ul className="space-y-2" data-testid="one-location-map-people">
            {markers.map((row) => {
              const fresh = liveFreshness(row.point.capturedAt, now, staleMs);
              const selected =
                focus.kind === "grant" && focus.grantId === row.grant.id;
              return (
                <li key={row.grant.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setFocus({ kind: "grant", grantId: row.grant.id });
                      setViewportResetKey((value) => value + 1);
                    }}
                    aria-pressed={selected}
                    className={cn(
                      SUBCARD_SURFACE,
                      "flex min-h-11 w-full items-center gap-3 p-3 text-left",
                      selected && "ring-2 ring-[color:var(--app-accent)]",
                    )}
                  >
                    <AvatarBubble
                      initials={initialsFor(ownerName(row.grant))}
                      imageUrl={row.grant.ownerPhotoUrl}
                      size={32}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="ui-text-row-label-emphasized block truncate">
                        {ownerName(row.grant)}
                      </span>
                      <span className={cn(MUTED_TEXT, "block")}>
                        {fresh.state === "live" ? "Live" : "Paused"} ·{" "}
                        {fresh.agoLabel}
                        {row.point.precision === "approximate"
                          ? " · approximate"
                          : ""}
                      </span>
                    </span>
                    <StatusPill
                      tone={fresh.state === "live" ? "live" : "neutral"}
                    >
                      {fresh.state === "live" ? "Live" : "Paused"}
                    </StatusPill>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : status === "ready" ? (
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden />}
            title="No one is sharing with you right now"
            description="When someone shares their location with you, they appear here and on the map."
          />
        ) : null}
      </section>
    </main>
  );
}
