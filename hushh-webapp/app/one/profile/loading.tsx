/**
 * Profile has a shared client workspace and cache-first mandate guard.
 *
 * The root loading boundary is intentionally skeletal for cold, untyped route
 * segments. Replacing the Profile shell with that generic placeholder during a
 * same-session navigation causes a visible flash before the app-wide route
 * crossfade can settle. Cold auth and mandate states stay owned by their
 * guards; warm Profile transitions keep the existing shell and crossfade.
 */
export default function ProfileLoading() {
  return null;
}
