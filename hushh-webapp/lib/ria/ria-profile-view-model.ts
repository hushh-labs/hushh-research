import {
  normalizeRiaOnboardingDraft,
  type RiaOnboardingDraft,
} from "@/lib/ria/ria-onboarding-flow";
import type { RiaOnboardingStatus } from "@/lib/services/ria-service";

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

export type RiaProfileReviewProps = {
  advisorName: string;
  firmName: string;
  crdNumber: string;
  regulator: string;
  regulatorStatus: string;
  certifications: string[];
  servicesOffered: string[];
  feeStructure: string[];
  minEngagementAmount: string;
  bio: string;
  city: string;
  pinZip: string;
  areaLocality: string;
  fullStreetAddress: string;
  advisoryAccessReady: boolean;
};

export function isRiaAdvisoryAccessReady(
  status: RiaOnboardingStatus | null | undefined,
): boolean {
  const value = (
    status?.advisory_status ||
    status?.verification_status ||
    ""
  ).toLowerCase();
  return value === "active" || value === "verified";
}

// Map the server-backed onboarding status onto the props OnboardingStepReview
// already renders, so the RIA profile read view reuses that component verbatim.
export function mapRiaStatusToReviewProps(
  status: RiaOnboardingStatus | null | undefined,
): RiaProfileReviewProps {
  return {
    advisorName:
      text(status?.display_name) ||
      text(status?.individual_legal_name) ||
      text(status?.legal_name),
    firmName:
      text(status?.advisory_firm_legal_name) ||
      text(status?.broker_firm_legal_name),
    crdNumber: text(status?.individual_crd) || text(status?.finra_crd),
    regulator: text(status?.regulator),
    regulatorStatus: text(status?.regulator_status),
    certifications: stringArray(status?.certifications),
    servicesOffered: stringArray(status?.services_offered),
    feeStructure: stringArray(status?.fee_structure),
    minEngagementAmount:
      status?.min_engagement_amount != null
        ? String(status.min_engagement_amount)
        : "",
    bio: text(status?.bio),
    city: text(status?.business_city),
    pinZip: text(status?.business_pin_zip),
    areaLocality: text(status?.business_area),
    fullStreetAddress: text(status?.business_address),
    advisoryAccessReady: isRiaAdvisoryAccessReady(status),
  };
}

// Seed an editable onboarding draft from the server status so the profile edit
// panel reuses the onboarding step components (which bind to RiaOnboardingDraft).
export function seedRiaDraftFromStatus(
  status: RiaOnboardingStatus | null | undefined,
): RiaOnboardingDraft {
  const props = mapRiaStatusToReviewProps(status);
  return normalizeRiaOnboardingDraft({
    onboardingType: status?.onboarding_type === "firm" ? "firm" : "individual",
    advisorName: props.advisorName,
    displayName: props.advisorName,
    individualLegalName: text(status?.individual_legal_name) || props.advisorName,
    firmName: props.firmName,
    advisoryFirmName: props.firmName,
    crdNumber: props.crdNumber,
    individualCrd: props.crdNumber,
    regulator: props.regulator,
    regulatorStatus: props.regulatorStatus,
    licenseNumber: text(status?.license_number),
    certifications: props.certifications,
    servicesOffered: props.servicesOffered,
    feeStructure: props.feeStructure,
    minEngagementAmount: props.minEngagementAmount,
    bio: props.bio,
    strategySummary: text(status?.strategy),
    city: props.city,
    pinZip: props.pinZip,
    areaLocality: props.areaLocality,
    fullStreetAddress: props.fullStreetAddress,
    // The profile save sends `draft.latitude/longitude` verbatim. Leaving them
    // unseeded meant every save wrote undefined over whatever coordinates the
    // record already held, so opening the edit panel and saving silently
    // dropped the adviser's geocoded office.
    latitude: number(status?.business_latitude),
    longitude: number(status?.business_longitude),
    contactEmail: text(status?.contact_email),
    contactPhone: text(status?.contact_phone),
    licenseVerificationStatus: isRiaAdvisoryAccessReady(status)
      ? "found"
      : "idle",
  });
}
