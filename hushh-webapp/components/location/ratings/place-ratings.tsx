"use client";

/**
 * `/one/location?action=ratings` — the star ratings you have given places.
 *
 * Ratings are for PLACES only. There is no such thing as rating a person here
 * or anywhere else in Location, and this screen never renders one.
 *
 * Availability is a server decision (the nearby check-in cohort). The build
 * gate is checked first; then the server is asked, and a
 * `NEARBY_PRESENCE_UNAVAILABLE` answer — or an explicit cohort flag in the
 * viewer capabilities, when the server sends one — hides the ratings entirely
 * behind "Ratings aren't available for your account yet." A voice
 * `list_my_place_ratings` result of `unsupported` lands in the same state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MapPin, Star, Trash2 } from "@/components/icons";

import {
  StarRatingInput,
  type StarRatingValue,
} from "@/components/one-location/nearby-check-in/star-rating-input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  CARD_SURFACE,
  MUTED_TEXT,
  SUBCARD_SURFACE,
} from "@/lib/morphy-ux/tokens/surfaces";
import {
  EmptyState,
  TaskFlowHeader,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { isOneLocationNearbyCheckInAvailable } from "@/lib/one-location/nearby-check-in-availability";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import {
  PLACE_RATING_CONSENT_POINTS,
  PLACE_RATING_CONSENT_VERSION,
  PLACE_RATING_PRIVACY_LINE,
} from "@/lib/one-location/place-rating-consent";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationPlaceRating,
  OneLocationRateableVisit,
  OneLocationViewerCapabilities,
} from "@/lib/one-location/types";
import type { ToolResultPublic } from "@/lib/one-voice/protocol";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { apiErrorCode } from "@/lib/services/api-client";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const SCREEN_ID = "one_location_ratings";
const VOICE_ACTIONS = deriveLocationVoiceActions(SCREEN_ID);

export const RATINGS_UNAVAILABLE_MESSAGE =
  "Ratings aren't available for your account yet.";

/**
 * What the server's viewer capabilities say about the ratings cohort, if
 * anything. The current payload carries no such key; when one arrives (any
 * boolean whose name mentions nearby, rate or ratings) it is honoured here,
 * and until then the server's own 404 decides.
 */
export function ratingsCohortFromCapabilities(
  capabilities:
    OneLocationViewerCapabilities | Record<string, unknown> | null | undefined,
): boolean | null {
  if (!capabilities || typeof capabilities !== "object") return null;
  for (const [key, value] of Object.entries(capabilities)) {
    if (typeof value !== "boolean") continue;
    if (/nearby|rating|rate/i.test(key)) return value;
  }
  return null;
}

function ratingsUnavailableError(error: unknown): boolean {
  return apiErrorCode(error) === "NEARBY_PRESENCE_UNAVAILABLE";
}

type Availability = "checking" | "available" | "unavailable";
type LoadStatus = "idle" | "loading" | "ready" | "error";

function StarRow({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={cn(
            "h-3.5 w-3.5",
            star <= rating
              ? "fill-current text-[color:var(--app-accent)]"
              : "text-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(time));
}

export function PlaceRatings() {
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const buildAllows = isOneLocationNearbyCheckInAvailable();
  const capabilityFlag = useMemo(
    () =>
      userId
        ? ratingsCohortFromCapabilities(
            OneLocationStateResource.readPresentation(userId)
              ?.viewerCapabilities ?? null,
          )
        : null,
    [userId],
  );
  const [availability, setAvailability] = useState<Availability>(() =>
    !buildAllows || capabilityFlag === false ? "unavailable" : "checking",
  );
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [ratings, setRatings] = useState<OneLocationPlaceRating[]>([]);
  const [visits, setVisits] = useState<OneLocationRateableVisit[]>([]);
  const [draft, setDraft] = useState<Record<string, StarRatingValue>>({});
  const [busyPlaceId, setBusyPlaceId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  usePublishVoiceSurfaceMetadata(
    userId
      ? {
          screenId: SCREEN_ID,
          title: "Ratings",
          purpose:
            availability === "available"
              ? "The star ratings you've given places you checked in at."
              : RATINGS_UNAVAILABLE_MESSAGE,
          spokenSubject: "Location, Ratings",
          actions: VOICE_ACTIONS,
          availableActions:
            availability === "available"
              ? VOICE_ACTIONS.map((action) => action.label)
              : [],
        }
      : null,
  );

  const load = useCallback(async () => {
    if (!vaultOwnerToken || !buildAllows || capabilityFlag === false) return;
    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const [nextRatings, nextVisits] = await Promise.all([
        OneLocationService.listPlaceRatings(vaultOwnerToken),
        OneLocationService.listRateableVisits(vaultOwnerToken).catch(
          (caught: unknown) => {
            if (ratingsUnavailableError(caught)) throw caught;
            return [] as OneLocationRateableVisit[];
          },
        ),
      ]);
      if (!mountedRef.current) return;
      setRatings(nextRatings);
      setVisits(nextVisits);
      setAvailability("available");
      setError(null);
      setStatus("ready");
    } catch (caught) {
      if (!mountedRef.current) return;
      if (ratingsUnavailableError(caught)) {
        setAvailability("unavailable");
        setStatus("ready");
        return;
      }
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't load your ratings.",
      );
      setStatus("error");
    }
  }, [buildAllows, capabilityFlag, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useVoiceToolEffects({
    onToolResult: (tool, result: ToolResultPublic) => {
      if (tool !== "list_my_place_ratings") return;
      if (result.status === "unsupported") {
        setAvailability("unavailable");
        return;
      }
      if (result.status === "listed" || result.status === "empty") void load();
    },
  });

  const rate = useCallback(
    async (visit: OneLocationRateableVisit) => {
      const value = draft[visit.placeId];
      if (!vaultOwnerToken || !value || busyPlaceId) return;
      setBusyPlaceId(visit.placeId);
      try {
        await OneLocationService.ratePlace({
          vaultOwnerToken,
          placeId: visit.placeId,
          rating: value,
          consentVersion: PLACE_RATING_CONSENT_VERSION,
        });
        morphyToast.success(`Rated ${visit.placeLabel ?? "the place"}.`);
        setDraft((current) => {
          const next = { ...current };
          delete next[visit.placeId];
          return next;
        });
        await load();
      } catch (caught) {
        if (ratingsUnavailableError(caught)) {
          setAvailability("unavailable");
          return;
        }
        morphyToast.error(
          caught instanceof Error && caught.message
            ? caught.message
            : "Couldn't save that rating.",
        );
      } finally {
        if (mountedRef.current) setBusyPlaceId(null);
      }
    },
    [busyPlaceId, draft, load, vaultOwnerToken],
  );

  const remove = useCallback(
    async (rating: OneLocationPlaceRating) => {
      if (!vaultOwnerToken || busyPlaceId) return;
      setBusyPlaceId(rating.placeId);
      try {
        await OneLocationService.deletePlaceRating({
          vaultOwnerToken,
          placeId: rating.placeId,
        });
        morphyToast.success(`Removed your rating for ${rating.placeLabel}.`);
        await load();
      } catch (caught) {
        morphyToast.error(
          caught instanceof Error && caught.message
            ? caught.message
            : "Couldn't remove that rating.",
        );
      } finally {
        if (mountedRef.current) setBusyPlaceId(null);
      }
    },
    [busyPlaceId, load, vaultOwnerToken],
  );

  if (availability === "unavailable") {
    return (
      <section
        className="space-y-5"
        data-testid="one-location-ratings"
        data-ratings-available="false"
      >
        <TaskFlowHeader eyebrow="Location" title="Ratings" />
        <EmptyState
          icon={<Star className="h-6 w-6" aria-hidden />}
          title={RATINGS_UNAVAILABLE_MESSAGE}
          description="Place ratings open up with nearby check-in. Nothing about you or anyone else is rated."
        />
      </section>
    );
  }

  return (
    <section
      className="space-y-5"
      data-testid="one-location-ratings"
      data-ratings-available={
        availability === "available" ? "true" : "checking"
      }
    >
      <TaskFlowHeader
        eyebrow="Location"
        title="Ratings"
        description="Stars you've given places you checked in at. Places only — never people."
      />

      {(availability === "checking" || status === "loading") &&
      !ratings.length &&
      !visits.length ? (
        <div className="flex items-center gap-2 py-6" role="status">
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span className={MUTED_TEXT}>Loading your ratings…</span>
        </div>
      ) : null}

      {status === "error" ? (
        <EmptyState
          title="Couldn't load your ratings"
          description={error ?? "Try again in a moment."}
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {availability === "available" && visits.length ? (
        <div
          className={cn(CARD_SURFACE, "space-y-3 p-4")}
          data-testid="rateable-visits"
        >
          <div>
            <h2 className="ui-text-section-title">Places you can rate</h2>
            <p className={MUTED_TEXT}>{PLACE_RATING_PRIVACY_LINE}</p>
          </div>
          <ul className="space-y-2">
            {visits.map((visit) => {
              const labelId = `rate-${visit.visitId}`;
              return (
                <li
                  key={visit.visitId}
                  className={cn(SUBCARD_SURFACE, "space-y-2 p-3")}
                >
                  <p id={labelId} className="ui-text-row-label-emphasized">
                    How was {visit.placeLabel ?? "this place"}?
                  </p>
                  <StarRatingInput
                    value={draft[visit.placeId] ?? null}
                    labelledBy={labelId}
                    disabled={busyPlaceId === visit.placeId}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        [visit.placeId]: value,
                      }))
                    }
                  />
                  <Button
                    size="sm"
                    disabled={
                      !draft[visit.placeId] || busyPlaceId === visit.placeId
                    }
                    onClick={() => void rate(visit)}
                  >
                    {busyPlaceId === visit.placeId ? "Saving…" : "Save rating"}
                  </Button>
                </li>
              );
            })}
          </ul>
          <details>
            <summary className={cn(MUTED_TEXT, "cursor-pointer")}>
              What a rating means
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {PLACE_RATING_CONSENT_POINTS.map((point) => (
                <li key={point} className={MUTED_TEXT}>
                  {point}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}

      {availability === "available" && status === "ready" && !ratings.length ? (
        <EmptyState
          icon={<MapPin className="h-6 w-6" aria-hidden />}
          title="You haven't rated any places yet"
          description="After you check in somewhere, you can leave a star rating here."
        />
      ) : null}

      {availability === "available" && ratings.length ? (
        <ul className="space-y-2" data-testid="place-ratings">
          {ratings.map((rating) => {
            const when = formatDate(
              rating.updatedAt ?? rating.createdAt ?? rating.visitedAt,
            );
            return (
              <li
                key={rating.id}
                className={cn(SUBCARD_SURFACE, "flex items-center gap-3 p-3.5")}
                data-testid="place-rating"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
                  <MapPin className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="ui-text-row-label-emphasized truncate">
                    {rating.placeLabel}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <StarRow rating={rating.rating} />
                    <span className={MUTED_TEXT}>
                      {rating.rating} of 5{when ? ` · ${when}` : ""}
                      {!rating.countsTowardAverage ? " · not averaged" : ""}
                    </span>
                  </div>
                </div>
                <Button
                  size="icon-lg"
                  variant="ghost"
                  aria-label={`Remove your rating for ${rating.placeLabel}`}
                  disabled={busyPlaceId === rating.placeId}
                  onClick={() => void remove(rating)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
