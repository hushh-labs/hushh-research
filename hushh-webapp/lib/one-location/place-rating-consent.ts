/**
 * What a person agrees to when they rate a place.
 *
 * Mirrors `PLACE_RATING_CONSENT_VERSION` in the backend's
 * `one_location_place_rating_service.py`. Unlike the map-renderer consent this
 * is modelled on, there is **no local cache and no standing preference**: the
 * version travels with every single save, the server checks it against its own
 * current value, and a mismatch is rejected. A stale client must not be able to
 * write a permanent record under a promise it never displayed, and rating a
 * place is an act rather than a posture — so it is never pre-accepted.
 */
export const PLACE_RATING_CONSENT_VERSION = "one-location-place-rating-v1";

/**
 * The six things the version above stands for, in the order they matter.
 *
 * Point 4 is the one the design would otherwise leave unsaid. Everything about
 * nearby check-in exists so that no durable record of where somebody has been
 * survives; a rating is the deliberate exception, and the person making it is
 * owed that sentence in plain words rather than in a schema comment.
 */
export const PLACE_RATING_CONSENT_POINTS = [
  "Your star rating is saved to your own list of places you've been.",
  "Your note stays on your device, encrypted. It never reaches our servers.",
  "Your rating counts toward an anonymous average for this place, shown only once at least five people have rated it.",
  "Being at the place is what lets you rate it, so your rating is tied to a visit you made.",
  "Nobody sees your name, and no one can tell which rating was yours.",
  "You can delete your rating at any time, and the average forgets it straight away.",
] as const;

/** The single line the sheet shows above the stars. Everything else is detail. */
export const PLACE_RATING_PRIVACY_LINE = "Only you see this.";
