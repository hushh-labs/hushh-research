// A domain manifest whose `profile` scope is a materialized, consumer-visible
// share bundle — the shape buildPkmShareBundles() keeps. `posture` sets whether
// the scope is currently "ask before sharing" (consent_required) or private.
export function financialManifest(posture: "consent_required" | "private") {
  return {
    domain: "financial",
    manifest_version: 7,
    scope_registry: [
      {
        scope_handle: "financial.profile",
        scope_label: "Profile",
        visibility_posture: posture,
        exposure_enabled: posture !== "private",
        summary_projection: {
          top_level_scope_path: "profile",
          materialization_state: "materialized",
          materialized_leaf_count: 2,
          consumer_visible: true,
          internal_only: false,
        },
      },
    ],
  };
}
