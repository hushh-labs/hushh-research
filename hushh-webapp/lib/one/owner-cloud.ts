/**
 * The owner-cloud question, asked one way across the app.
 *
 * An owner cloud is a home the person controls and pays for: their own Google
 * Cloud project or their own Microsoft Azure subscription. This mirrors
 * `is_owner_cloud_target` in
 * `consent-protocol/hushh_mcp/services/compute_backend.py`; the hub is the
 * authority and this asks the same question of the same identifiers, so no
 * surface spells `=== "user_gcp"` and silently refuses the second cloud.
 *
 * Matching is exact on purpose. The hub emits these identifiers verbatim, and a
 * near-miss (`" user_gcp"`, `"USER_GCP"`) is a malformed record that must fail
 * closed rather than be coerced into an owner cloud.
 */

export const OWNER_CLOUD_TARGETS = ["user_gcp", "user_azure"] as const;

export type OwnerCloudTarget = (typeof OWNER_CLOUD_TARGETS)[number];

export type OwnerCloudProvider = "gcp" | "azure";

const PROVIDER_BY_TARGET: Readonly<Record<OwnerCloudTarget, OwnerCloudProvider>> = {
  user_gcp: "gcp",
  user_azure: "azure",
};

/** The provider's name as a person reads it. */
export const OWNER_CLOUD_PROVIDER_LABELS: Readonly<Record<OwnerCloudProvider, string>> = {
  gcp: "Google Cloud",
  azure: "Microsoft Azure",
};

export function isOwnerCloudTarget(target: unknown): target is OwnerCloudTarget {
  return (
    typeof target === "string" &&
    (OWNER_CLOUD_TARGETS as readonly string[]).includes(target)
  );
}

/** Which owner cloud a deployment target names, or `null` for any other home. */
export function ownerCloudProvider(target: unknown): OwnerCloudProvider | null {
  return isOwnerCloudTarget(target) ? PROVIDER_BY_TARGET[target] : null;
}

/**
 * Whether a person may choose Azure as a NEW home on this build.
 *
 * Azure becomes selectable only once each admission gate has live evidence
 * (`docs/reference/architecture/byoc-azure.md`, admission bar), so the choice
 * ships dark: a build sets `NEXT_PUBLIC_AZURE_BYOC_SELECTABLE=1` where Azure is
 * admitted (localhost first, then the dev lane). This gates choosing only; an
 * agent that already lives in Azure is always shown and always updatable.
 */
export function isAzureHomeSelectable(): boolean {
  return process.env.NEXT_PUBLIC_AZURE_BYOC_SELECTABLE === "1";
}
