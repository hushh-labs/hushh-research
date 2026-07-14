/**
 * Setup workspaces share a cached, redacted journey record. Their route
 * adapters own the small cold-state wait when that record is genuinely absent;
 * a segment-level skeleton here would otherwise flash on every capability
 * switch (for example, hub → Gmail) and mask the preserved shell.
 */
export default function OneSetupLoading() {
  return null;
}
