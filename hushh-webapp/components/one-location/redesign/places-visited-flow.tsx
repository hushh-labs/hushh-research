"use client";

/**
 * Places you've been.
 *
 * The other half of rating a visit: somewhere to read back what you said. It
 * is assembled from two stores that never meet on a server —
 *
 *   the server  the star, because an average and one-vote-per-place cannot be
 *               computed on a device;
 *   the vault   the note, because free text about a named business, sitting in
 *               plaintext beside a venue and a timestamp, is a movement log
 *               with commentary.
 *
 * The join happens here, on the reader's own device, keyed on `placeId`. That
 * is the only place the two halves are ever in the same memory, and it is the
 * reason there is no "recent reviews" endpoint to build later by accident.
 *
 * A locked vault degrades to stars-only rather than to an empty screen: the
 * ratings are still yours and still readable, you simply do not get the notes
 * back until you unlock.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, MapPin, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  EmptyState,
  TaskFlowHeader,
} from "@/components/one-location/redesign/primitives";
import { STAR_RATING_ADJECTIVES } from "@/components/one-location/nearby-check-in/star-rating-input";
import { OneLocationService } from "@/lib/one-location/service";
import { googleWriteReviewUrl } from "@/lib/one-location/maps-urls";
import {
  canWriteVisitNotes,
  loadVisitNotes,
  removeVisitNote,
  type VisitNote,
} from "@/lib/one-location/visit-notes";
import type { OneLocationPlaceRating } from "@/lib/one-location/types";
import { isNative } from "@/lib/capacitor/platform";
import { cn } from "@/lib/utils";

/** One row: the server's rating, with the vault's note folded in where there
 *  is one to fold. */
type VisitedPlace = {
  placeId: string;
  label: string;
  rating: number;
  note: string | null;
  ratedAt: string | null;
  countsTowardAverage: boolean;
  googleReviewUrl: string | null;
};

function joinRatingsAndNotes(
  ratings: OneLocationPlaceRating[],
  notes: VisitNote[],
): VisitedPlace[] {
  const notesByPlace = new Map(notes.map((note) => [note.placeId, note]));
  return ratings.map((rating) => {
    const note = notesByPlace.get(rating.placeId);
    return {
      placeId: rating.placeId,
      // The server's label is the one it recorded at check-in, so it wins over
      // a stale vault copy of the same name.
      label: rating.placeLabel || note?.label || "A place",
      rating: rating.rating,
      note: note?.note ?? null,
      ratedAt: rating.updatedAt ?? rating.createdAt ?? null,
      countsTowardAverage: rating.countsTowardAverage,
      googleReviewUrl:
        rating.googleReviewUrl ?? googleWriteReviewUrl(rating.placeId),
    };
  });
}

function StarRow({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={cn(
            "h-3.5 w-3.5",
            star <= rating
              ? "fill-current text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]"
              : "text-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}

export function PlacesVisitedFlow() {
  // Sourced from the hooks rather than threaded through the hub's view model,
  // the same way `SavedLocationsSection` does it -- the vault context belongs
  // to whoever is reading, not to the screen that opened them.
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const ownerId = user?.uid ?? null;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ratings, setRatings] = useState<OneLocationPlaceRating[]>([]);
  const [notes, setNotes] = useState<VisitNote[]>([]);
  const [removing, setRemoving] = useState<VisitedPlace | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);

  const vaultContext = useMemo(
    () => ({ userId: ownerId ?? "", vaultKey, vaultOwnerToken }),
    [ownerId, vaultKey, vaultOwnerToken],
  );
  const notesReadable = canWriteVisitNotes(vaultContext);

  const load = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setLoading(true);
    setLoadError(null);
    try {
      const serverRatings =
        await OneLocationService.listPlaceRatings(vaultOwnerToken);
      setRatings(serverRatings);
      // The notes are a second, independent read. A locked or unreachable
      // vault costs the notes, never the list.
      if (notesReadable) {
        setNotes(await loadVisitNotes(vaultContext).catch(() => []));
      } else {
        setNotes([]);
      }
    } catch {
      setLoadError("Couldn't load your places. Try again.");
    } finally {
      setLoading(false);
    }
  }, [notesReadable, vaultContext, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const places = useMemo(
    () => joinRatingsAndNotes(ratings, notes),
    [ratings, notes],
  );

  const confirmRemove = async () => {
    const target = removing;
    if (!target || !vaultOwnerToken || removingBusy) return;
    setRemovingBusy(true);
    try {
      await OneLocationService.deletePlaceRating({
        vaultOwnerToken,
        placeId: target.placeId,
      });
      // Both halves, or a note outlives the rating it belonged to and the
      // place reappears with no stars the next time this screen loads.
      if (notesReadable) {
        await removeVisitNote({
          context: vaultContext,
          placeId: target.placeId,
        }).catch(() => undefined);
      }
      setRatings((current) =>
        current.filter((rating) => rating.placeId !== target.placeId),
      );
      setNotes((current) =>
        current.filter((note) => note.placeId !== target.placeId),
      );
      setRemoving(null);
      toast.success("Removed.");
    } catch {
      toast.error("Couldn't remove that rating.");
    } finally {
      setRemovingBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="one-location-places-visited">
      <TaskFlowHeader
        eyebrow="Location"
        title="Places you've been"
        description="Everywhere you rated after checking out. Only you can see this."
      />

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading your places…
        </div>
      ) : loadError ? (
        <div
          className="rounded-2xl border border-destructive/20 bg-destructive/10 p-4"
          role="alert"
        >
          <p className="text-sm text-destructive">{loadError}</p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => void load()}
          >
            Try again
          </Button>
        </div>
      ) : !places.length ? (
        <EmptyState
          title="Nothing rated yet"
          description="Check in somewhere, then check out — we'll ask how it went."
        />
      ) : (
        <SettingsGroup testId="one-location-visited-places">
          {places.map((place) => (
            <SettingsRow
              key={place.placeId}
              leading={
                <span
                  aria-hidden="true"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--app-neutral-fill)]"
                >
                  <MapPin className="h-4 w-4 text-[color:var(--app-secondary-label)]" />
                </span>
              }
              title={place.label}
              description={
                <span className="flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <StarRow rating={place.rating} />
                    <span className="text-xs text-muted-foreground">
                      {STAR_RATING_ADJECTIVES[
                        place.rating as 1 | 2 | 3 | 4 | 5
                      ] ?? ""}
                    </span>
                    <span className="sr-only">
                      {`${place.rating} out of 5`}
                    </span>
                  </span>
                  {place.note ? (
                    <span className="text-[13px] leading-4 text-muted-foreground">
                      {place.note}
                    </span>
                  ) : !notesReadable ? (
                    // Not an error. The rating is still theirs and still
                    // readable; the note simply lives behind the vault.
                    <span className="text-[13px] leading-4 text-muted-foreground/70">
                      Unlock your vault to see your note.
                    </span>
                  ) : null}
                </span>
              }
              trailing={
                <div className="flex shrink-0 items-center gap-1">
                  {place.googleReviewUrl ? (
                    <Button
                      asChild
                      variant="ghost"
                      size="sm"
                      className="h-9 min-h-9 rounded-full px-3 text-[color:var(--app-accent)]"
                    >
                      <a
                        href={place.googleReviewUrl}
                        target={isNative() ? undefined : "_blank"}
                        rel="noopener noreferrer"
                        aria-label={`Review ${place.label} on Google`}
                      >
                        Google
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove your rating for ${place.label}`}
                    className="h-9 w-9 shrink-0 rounded-full text-muted-foreground"
                    onClick={() => setRemoving(place)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              }
            />
          ))}
        </SettingsGroup>
      )}

      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove your rating for {removing?.label}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your note goes too, and the place&apos;s average forgets your
              rating straight away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-11 w-full sm:w-auto"
              onClick={(event) => {
                event.preventDefault();
                void confirmRemove();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
