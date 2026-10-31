/**
 * Opening animation for the Calendar connect illustration: the four side
 * tiles slide out from behind the schedule card and settle into place.
 *
 * Each tile is moved on its own wrapper, so the rotation on the tile inside
 * it is untouched. The motion is a Web Animation with a backwards fill: its
 * first keyframe holds the tile behind the card while it waits and during its
 * stagger delay, and when it ends (or is cancelled) the element simply returns
 * to its normal style. Nothing is left in inline styles, so no outcome can
 * strand a tile away from, or hidden from, its final position.
 */

export const ENTRANCE_DURATION_MS = 700;
export const ENTRANCE_STAGGER_MS = 50;

const START_SCALE = 0.85;
const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Set on a tile while it waits for the illustration to become visible. */
export const ENTRANCE_PENDING_ATTRIBUTE = "data-entrance";
export const ENTRANCE_PENDING_VALUE = "pending";

type EntranceTargets = {
  /** The illustration; observed so the animation waits until it is on screen. */
  root: HTMLElement;
  /** The opaque schedule card the tiles emerge from. */
  card: HTMLElement;
  /** Tile wrappers in play order. */
  tiles: readonly HTMLElement[];
};

/**
 * Plays the entrance once for the given elements and returns its cleanup.
 * Shows the final arrangement at once for reduced motion, or where the Web
 * Animations API is unavailable.
 */
export function startCalendarEntrance({ root, card, tiles }: EntranceTargets): () => void {
  const reducedMotion = window.matchMedia?.(REDUCED_MOTION_QUERY);
  const [firstTile] = tiles;
  if (
    !firstTile ||
    reducedMotion?.matches ||
    typeof firstTile.animate !== "function"
  ) {
    return () => undefined;
  }

  const animations: Animation[] = [];
  let started = false;
  let inView = typeof IntersectionObserver === "undefined";
  let observer: IntersectionObserver | undefined;

  const reveal = () => {
    for (const tile of tiles) tile.removeAttribute(ENTRANCE_PENDING_ATTRIBUTE);
  };
  const stopWaiting = () => {
    observer?.disconnect();
    observer = undefined;
    document.removeEventListener("visibilitychange", maybePlay);
  };

  const play = () => {
    const cardRect = card.getBoundingClientRect();
    if (cardRect.width <= 0 || cardRect.height <= 0) {
      reveal();
      return;
    }
    const centerX = cardRect.left + cardRect.width / 2;
    const centerY = cardRect.top + cardRect.height / 2;

    // Measure every tile before any animation exists, so no earlier tile's
    // transform can shift a later measurement.
    const starts = tiles.map((tile) => {
      const rect = tile.getBoundingClientRect();
      const dx = centerX - (rect.left + rect.width / 2);
      const dy = centerY - (rect.top + rect.height / 2);
      return `translate(${dx}px, ${dy}px) scale(${START_SCALE})`;
    });
    tiles.forEach((tile, index) => {
      animations.push(
        tile.animate(
          [{ transform: starts[index] }, { transform: "translate(0px, 0px) scale(1)" }],
          {
            duration: ENTRANCE_DURATION_MS,
            delay: index * ENTRANCE_STAGGER_MS,
            easing: EASE_OUT,
            fill: "backwards",
          },
        ),
      );
    });
    // The animations now hold every tile behind the card, so the tiles can be
    // shown in this same frame without ever appearing at their final spot.
    reveal();
  };

  function maybePlay() {
    if (started || !inView || document.visibilityState !== "visible") return;
    started = true;
    stopWaiting();
    play();
  }

  const onReducedMotionChange = (event: MediaQueryListEvent) => {
    if (!event.matches) return;
    started = true;
    stopWaiting();
    for (const animation of animations) animation.cancel();
    reveal();
  };

  // Hold the tiles out of sight until the illustration is actually visible;
  // `visibility` keeps their layout box, so they can still be measured.
  for (const tile of tiles) {
    tile.setAttribute(ENTRANCE_PENDING_ATTRIBUTE, ENTRANCE_PENDING_VALUE);
  }
  reducedMotion?.addEventListener?.("change", onReducedMotionChange);
  document.addEventListener("visibilitychange", maybePlay);
  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (!latest) return;
      inView = latest.isIntersecting;
      maybePlay();
    });
    observer.observe(root);
  }
  maybePlay();

  return () => {
    stopWaiting();
    reducedMotion?.removeEventListener?.("change", onReducedMotionChange);
    for (const animation of animations) animation.cancel();
    reveal();
  };
}
