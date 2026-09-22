import packageJson from "../../package.json";

/**
 * The app version stamped on every observability event.
 *
 * Every event on every platform was reporting `app_version: "unknown"`,
 * because `NEXT_PUBLIC_CLIENT_VERSION` is documented in `.env.example` but
 * never supplied to a real build. With no version on any event you cannot
 * answer whether a release changed a metric, whether an old build is still in
 * the wild, or whether new instrumentation actually shipped -- which is
 * exactly the question the native surfaces raise, since the last Android build
 * predates the identity module entirely.
 *
 * `NEXT_PUBLIC_*` is inlined at build time, so this is resolved in
 * `next.config.ts` (web) and `next.config.capacitor.ts` (iOS/Android) rather
 * than read at runtime. An explicitly supplied value still wins; the package
 * version is the floor, so the worst case is a real version rather than
 * "unknown".
 *
 * Known limitation: `package.json` moves per release, not per build, so two
 * builds of 1.1.0 are indistinguishable. Making it per-build needs a build ARG
 * threaded through `deploy/frontend.cloudbuild.yaml`, which is a protected
 * pipeline surface.
 */
export const CLIENT_VERSION_FALLBACK =
  String(packageJson.version || "").trim() || "unknown";

export function resolveClientVersion(): string {
  const version = String(process.env.NEXT_PUBLIC_CLIENT_VERSION || "").trim();
  return version || CLIENT_VERSION_FALLBACK;
}
