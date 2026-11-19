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

export const HOSTED_POD_TARGETS = ["gcp", "azure"] as const;

export type HostedPodTarget = (typeof HOSTED_POD_TARGETS)[number];

export type OwnerCloudProvider = "gcp" | "azure";

const PROVIDER_BY_TARGET: Readonly<Record<OwnerCloudTarget, OwnerCloudProvider>> = {
  user_gcp: "gcp",
  user_azure: "azure",
};

const HOSTED_PROVIDER_BY_TARGET: Readonly<Record<HostedPodTarget, OwnerCloudProvider>> = {
  gcp: "gcp",
  azure: "azure",
};

/** The provider's name as a person reads it. */
export const OWNER_CLOUD_PROVIDER_LABELS: Readonly<Record<OwnerCloudProvider, string>> = {
  gcp: "Google Cloud Platform",
  azure: "Microsoft Azure",
};

/** Concise cloud provider label used on Hussh Pods badges and summaries. */
export const HOSTED_POD_PROVIDER_LABELS: Readonly<Record<OwnerCloudProvider, string>> = {
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

/** Which cloud hosts a Hussh Pods deployment target (`gcp` or `azure`), or `null`. */
export function hostedPodProvider(target: unknown): OwnerCloudProvider | null {
  return typeof target === "string" && target in HOSTED_PROVIDER_BY_TARGET
    ? HOSTED_PROVIDER_BY_TARGET[target as HostedPodTarget]
    : null;
}

/** Which cloud provider hosts any private pod target (owner BYOC or Hussh Pods). */
export function podCloudProvider(target: unknown): OwnerCloudProvider | null {
  return ownerCloudProvider(target) ?? hostedPodProvider(target);
}

/** Display title identifying both Hussh Pods and its backing cloud provider when known. */
export function hostedPodDisplayLabel(target: unknown): string {
  const provider = hostedPodProvider(target);
  return provider ? `Hussh Pods · ${HOSTED_POD_PROVIDER_LABELS[provider]}` : "Hussh Pods";
}

/**
 * Whether a person may choose Azure as a NEW home on this build.
 *
 * Azure becomes selectable only once each admission gate has live evidence
 * (`docs/architecture/byoc-azure.md`, admission bar), so the choice
 * ships dark. It is admitted on a localhost build that sets
 * `NEXT_PUBLIC_AZURE_BYOC_SELECTABLE=1`, and on the hosted dev lane, whose web
 * build is compiled with `NEXT_PUBLIC_APP_ENV=dev` (exactly; UAT and production
 * never are). This gates choosing only; an agent that already lives in Azure is
 * always shown and always updatable.
 */
export function isAzureHomeSelectable(): boolean {
  if (process.env.NEXT_PUBLIC_AZURE_BYOC_SELECTABLE === "1") return true;
  return String(process.env.NEXT_PUBLIC_APP_ENV ?? "").trim().toLowerCase() === "dev";
}

/**
 * Whether the Hussh Pods card is paused for maintenance on this build.
 *
 * Explicit `NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE` ("0"/"false" vs "1"/"true")
 * always wins. When unset, the hosted `dev` lane (`NEXT_PUBLIC_APP_ENV=dev`)
 * opens the card for admitted Dev pilot owners while `uat`, `production`, and
 * unconfigured builds remain fail-closed (backend `/byoc/hosted/select` still
 * enforces fixed-cohort admission independently).
 */
export function isHostedPodTierUnderMaintenance(): boolean {
  const explicit = String(process.env.NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "0" || explicit === "false") return false;
  if (explicit === "1" || explicit === "true") return true;
  return String(process.env.NEXT_PUBLIC_APP_ENV ?? "").trim().toLowerCase() !== "dev";
}

/** Whether migrating an active pod onto Dev Hussh Pods (Azure Umbrella Cell) is available. */
export function isHostedAzureMigrationAvailable(): boolean {
  if (process.env.NEXT_PUBLIC_HOSTED_AZURE_MIGRATION_ENABLED === "1") return true;
  return String(process.env.NEXT_PUBLIC_APP_ENV ?? "").trim().toLowerCase() === "dev";
}

/** A private mode chooses direct admission; it never establishes authority. */
export function isPrivateHostingMode(mode: unknown): boolean {
  return mode === "byoc" || mode === "hussh_pods";
}

/** Only use on a signature-verified binding, never an unsigned hosting status. */
export function isPrivatePodBinding(binding: Record<string, unknown>): boolean {
  if (isOwnerCloudTarget(binding.deployment_target)) {
    return !("hosting_mode" in binding);
  }
  if (binding.deployment_target === "ace" && !("hosting_mode" in binding)) {
    return binding.environment === "dev";
  }
  return (
    (binding.deployment_target === "gcp" || binding.deployment_target === "azure")
    && binding.hosting_mode === "hussh_hosted"
    && binding.environment === "dev"
  );
}
