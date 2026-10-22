import { REQUEST_DURATION_OPTIONS } from "@/lib/agent/action-directive-summary";
import { buildPkmShareBundles } from "@/lib/profile/pkm-memory-tree";
import { consentScopeForPermission } from "@/lib/personal-knowledge-model/slice-publishing";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import type { SharingPriceReviewRequest } from "@/components/consent/scope-tariff-editor";
import { isPrivatePkmExportScope } from "@/lib/consent/pkm-scope-policy";

export type SharingPriceTarget = {
  domain: string; scopeHandle: string; machineScope: string; label: string; manifestVersion: number;
};

/** Proposals are bounded form inputs, never authority to write a tariff. */
export function parseSharingPriceProposal(slots: Record<string, unknown>): Omit<SharingPriceReviewRequest, "id"> {
  const integer = (value: unknown) => {
    if (value === undefined || value === null || value === "") return undefined;
    if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) throw new Error("Use a whole number of cents and a supported base term.");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error("Check the proposed price and term.");
    return parsed;
  };
  const proposedPriceCents = integer(slots.proposed_price_cents);
  const proposedBaseHours = integer(slots.proposed_base_hours);
  if (proposedPriceCents !== undefined && proposedPriceCents > 100_000) throw new Error("The maximum sharing price is $1,000.");
  if (proposedBaseHours !== undefined && !REQUEST_DURATION_OPTIONS.some(option => option.hours === proposedBaseHours)) throw new Error("Choose a supported base access term.");
  return { proposedPriceCents, proposedBaseHours };
}

/** Only unique materialized handles in the current manifest can open pricing. */
export function sharingPriceTargets(manifest: DomainManifest, scopeEntries: ReadonlyArray<Record<string, unknown>> = []): SharingPriceTarget[] {
  if (!Number.isSafeInteger(manifest.manifest_version) || manifest.manifest_version < 1) return [];
  const bundles = buildPkmShareBundles(manifest);
  const sections = bundles.filter(bundle => bundle.scopeHandle?.trim() &&
    bundles.filter(other => other.scopeHandle === bundle.scopeHandle).length === 1 &&
    bundles.filter(other => other.topLevelScopePath === bundle.topLevelScopePath).length === 1,
  ).map(bundle => ({
    domain: manifest.domain, scopeHandle: bundle.scopeHandle!,
    machineScope: consentScopeForPermission(manifest.domain, bundle.topLevelScopePath),
    label: bundle.label, manifestVersion: manifest.manifest_version,
  }));
  const whole = scopeEntries.filter(entry => entry.scope === `attr.${manifest.domain}.*` &&
    entry.domain === manifest.domain && entry.wildcard === true && entry.path === null &&
    entry.consumer_visible !== false && entry.internal_only !== true && entry.exposure_eligibility !== false &&
    entry.materialization_state === "materialized" && typeof entry.scope_handle === "string" && entry.scope_handle.trim());
  if (isPrivatePkmExportScope(`attr.${manifest.domain}.*`) || whole.length !== 1 || !bundles.length || bundles.some(bundle => !bundle.enabled)) return sections;
  return [{ domain: manifest.domain, scopeHandle: String(whole[0]!.scope_handle), machineScope: String(whole[0]!.scope),
    label: `${manifest.domain.replaceAll("_", " ")} bundle`, manifestVersion: manifest.manifest_version }, ...sections];
}

/** An exact locator can select a section; a leaf never selects its parent. */
export function matchesSharingPriceSection(target: SharingPriceTarget, section: string): boolean {
  const normalized = section.trim().toLowerCase();
  return [target.label, `${target.domain}: ${target.label}`, target.machineScope,
    ...(target.machineScope === `attr.${target.domain}.*` ? [target.domain] : [])]
    .some(value => value.toLowerCase() === normalized);
}
