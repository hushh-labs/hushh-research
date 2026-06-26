/**
 * Consent Module Exports
 * ======================
 *
 * Centralized exports for all consent-related utilities.
 */

// Actions Hook
export {
  useConsentActions,
  type ConsentActionState,
  type ConsentMutationDetail,
  type PendingConsent,
} from "./use-consent-actions";

// One Location Actions Hook (E2E location share lifecycle inside /consents)
export {
  useOneLocationConsentActions,
  type LocationConsentActionEntry,
} from "./use-one-location-consent-actions";

