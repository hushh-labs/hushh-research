import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import { scopeCommerceStatusCopy } from "@/lib/services/scope-commerce-service";
import { isLocationConsent, locationConsentSummary } from "@/lib/consent/location-consent";

export function consentSummary(entry: ConsentCenterEntry): string {
  if (entry.metadata?.commercial_required === true) {
    return scopeCommerceStatusCopy(entry.metadata.commerce_status);
  }
  if (entry.kind === "invite") return "Invitation waiting for your approval.";
  if (isLocationConsent(entry.metadata, entry.scope)) {
    return locationConsentSummary(entry.metadata);
  }
  return (
    entry.additional_access_summary ||
    entry.scope_description ||
    entry.reason ||
    entry.scope ||
    "A new consent request needs your review."
  );
}
