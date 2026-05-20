"use client";

export type RiaOnboardingType = "" | "individual" | "firm";

export type RiaCapability = "advisory" | "brokerage";

export type RiaOnboardingStepId =
  | "welcome"
  | "license_number"
  | "license_details"
  | "services"
  | "review";

export type RiaOnboardingDraft = {
  currentStepId: RiaOnboardingStepId;
  onboardingType: RiaOnboardingType;
  licenseNumber: string;
  regulator: string;
  advisorName: string;
  firmName: string;
  regulatorStatus: string;
  licenseExpiry: string;
  certifications: string[];
  city: string;
  pinZip: string;
  crdNumber: string;
  secNumber: string;
  servicesOffered: string[];
  feeStructure: string[];
  minEngagementAmount: string;
  bio: string;
  contactEmail: string;
  contactPhone: string;
  areaLocality: string;
  fullStreetAddress: string;
  latitude: number | null;
  longitude: number | null;
  licenseVerificationStatus:
    | "idle"
    | "verifying"
    | "found"
    | "not_found"
    | "error";
  scrapeJobId: string | null;
  requestedCapabilities: RiaCapability[];
  displayName: string;
  individualLegalName: string;
  individualCrd: string;
  advisoryFirmName: string;
  advisoryFirmIapdNumber: string;
  brokerFirmName: string;
  brokerFirmCrd: string;
  headline: string;
  strategySummary: string;
  verifiedLicensePrefillKey: string;
};

export type RiaOnboardingStep = {
  id: RiaOnboardingStepId;
  eyebrow: string;
  title: string;
  description: string;
};

export type RiaOnboardingFlowOptions = {
  licenseVerificationSatisfied?: boolean;
};

const STEP_ORDER: RiaOnboardingStepId[] = [
  "welcome",
  "license_number",
  "license_details",
  "services",
  "review",
];

const LEGACY_CONTACT_LOCATION_STEP_ID = "contact_location";

function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isRiaOnboardingStepId(
  value: unknown,
): value is RiaOnboardingStepId {
  return (
    typeof value === "string" &&
    STEP_ORDER.includes(value as RiaOnboardingStepId)
  );
}

function normalizeRiaOnboardingStepId(
  value: unknown,
): RiaOnboardingStepId | null {
  if (isRiaOnboardingStepId(value)) return value;
  if (value === LEGACY_CONTACT_LOCATION_STEP_ID) return "services";
  return null;
}

export function normalizeRiaCapabilities(value: unknown): RiaCapability[] {
  const input = Array.isArray(value) ? value : [];
  const set = new Set<RiaCapability>();
  for (const item of input) {
    if (item === "advisory" || item === "brokerage") {
      set.add(item);
    }
  }
  return Array.from(set);
}

export function createEmptyRiaOnboardingDraft(): RiaOnboardingDraft {
  return {
    currentStepId: "welcome",
    onboardingType: "individual",
    licenseNumber: "",
    regulator: "",
    advisorName: "",
    firmName: "",
    regulatorStatus: "",
    licenseExpiry: "",
    certifications: [],
    city: "",
    pinZip: "",
    crdNumber: "",
    secNumber: "",
    servicesOffered: [],
    feeStructure: [],
    minEngagementAmount: "",
    bio: "",
    contactEmail: "",
    contactPhone: "",
    areaLocality: "",
    fullStreetAddress: "",
    latitude: null,
    longitude: null,
    licenseVerificationStatus: "idle",
    scrapeJobId: null,
    requestedCapabilities: ["advisory"],
    displayName: "",
    individualLegalName: "",
    individualCrd: "",
    advisoryFirmName: "",
    advisoryFirmIapdNumber: "",
    brokerFirmName: "",
    brokerFirmCrd: "",
    headline: "",
    strategySummary: "",
    verifiedLicensePrefillKey: "",
  };
}

const VALID_VERIFICATION_STATUSES = [
  "idle",
  "verifying",
  "found",
  "not_found",
  "error",
];
const VALID_ONBOARDING_TYPES = ["individual", "firm"];

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

export function normalizeRiaOnboardingDraft(
  value: Partial<RiaOnboardingDraft> | null | undefined,
): RiaOnboardingDraft {
  const base = createEmptyRiaOnboardingDraft();
  const v = value as Record<string, unknown> | null | undefined;
  return {
    currentStepId:
      normalizeRiaOnboardingStepId(v?.currentStepId) || base.currentStepId,
    onboardingType:
      typeof v?.onboardingType === "string" &&
      VALID_ONBOARDING_TYPES.includes(v.onboardingType)
        ? (v.onboardingType as RiaOnboardingType)
        : base.onboardingType,
    licenseNumber: sanitizeText(v?.licenseNumber),
    regulator: sanitizeText(v?.regulator),
    advisorName: sanitizeText(v?.advisorName),
    firmName: sanitizeText(v?.firmName),
    regulatorStatus: sanitizeText(v?.regulatorStatus),
    licenseExpiry: sanitizeText(v?.licenseExpiry),
    certifications: sanitizeStringArray(v?.certifications),
    city: sanitizeText(v?.city),
    pinZip: sanitizeText(v?.pinZip),
    crdNumber: sanitizeText(v?.crdNumber),
    secNumber: sanitizeText(v?.secNumber),
    servicesOffered: sanitizeStringArray(v?.servicesOffered),
    feeStructure: sanitizeStringArray(v?.feeStructure),
    minEngagementAmount: sanitizeText(v?.minEngagementAmount),
    bio: sanitizeText(v?.bio),
    contactEmail: sanitizeText(v?.contactEmail),
    contactPhone: sanitizeText(v?.contactPhone),
    areaLocality: sanitizeText(v?.areaLocality),
    fullStreetAddress: sanitizeText(v?.fullStreetAddress),
    latitude: typeof v?.latitude === "number" ? v.latitude : null,
    longitude: typeof v?.longitude === "number" ? v.longitude : null,
    licenseVerificationStatus:
      typeof v?.licenseVerificationStatus === "string" &&
      VALID_VERIFICATION_STATUSES.includes(v.licenseVerificationStatus)
        ? (v.licenseVerificationStatus as RiaOnboardingDraft["licenseVerificationStatus"])
        : base.licenseVerificationStatus,
    scrapeJobId: typeof v?.scrapeJobId === "string" ? v.scrapeJobId : null,
    requestedCapabilities:
      normalizeRiaCapabilities(v?.requestedCapabilities).length > 0
        ? normalizeRiaCapabilities(v?.requestedCapabilities)
        : base.requestedCapabilities,
    displayName: sanitizeText(v?.displayName),
    individualLegalName: sanitizeText(v?.individualLegalName),
    individualCrd: sanitizeText(v?.individualCrd),
    advisoryFirmName: sanitizeText(v?.advisoryFirmName),
    advisoryFirmIapdNumber: sanitizeText(v?.advisoryFirmIapdNumber),
    brokerFirmName: sanitizeText(v?.brokerFirmName),
    brokerFirmCrd: sanitizeText(v?.brokerFirmCrd),
    headline: sanitizeText(v?.headline),
    strategySummary: sanitizeText(v?.strategySummary),
    verifiedLicensePrefillKey: sanitizeText(v?.verifiedLicensePrefillKey),
  };
}

export function buildRiaOnboardingSteps(
  _draft: RiaOnboardingDraft,
  _options?: RiaOnboardingFlowOptions,
): RiaOnboardingStep[] {
  return [
    {
      id: "welcome",
      eyebrow: "Welcome",
      title: "How would you like to register?",
      description:
        "Choose whether you are onboarding as an individual advisor or registering a firm or practice.",
    },
    {
      id: "license_number",
      eyebrow: "Licence",
      title: "Enter your licence number",
      description:
        "Provide your CRD or licence number so Kai can verify your registration with the regulator.",
    },
    {
      id: "license_details",
      eyebrow: "Verification",
      title: "Verify your details",
      description:
        "Review the information prepopulated from the regulator database and correct anything that looks off.",
    },
    {
      id: "services",
      eyebrow: "Services",
      title: "What do you offer?",
      description:
        "List the services you provide, how you charge, and where your business is located.",
    },
    {
      id: "review",
      eyebrow: "Review",
      title: "Everything correct?",
      description:
        "Confirm your details are accurate. Once submitted your profile will go live as pending verification.",
    },
  ];
}

export function canContinueRiaOnboardingStep(
  stepId: RiaOnboardingStepId,
  draft: RiaOnboardingDraft,
  options?: RiaOnboardingFlowOptions,
): boolean {
  switch (stepId) {
    case "welcome":
      return draft.onboardingType.length > 0;
    case "license_number":
      return (
        draft.licenseNumber.trim().length > 0 &&
        Boolean(options?.licenseVerificationSatisfied)
      );
    case "license_details":
      return draft.advisorName.trim().length > 0;
    case "services":
      return draft.servicesOffered.length > 0 && draft.feeStructure.length > 0;
    case "review":
      return true;
    default:
      return false;
  }
}

export function getOnboardingTypeLabel(type: RiaOnboardingType): string {
  return type === "individual" ? "Individual RIA" : "Firm / Practice";
}

export function resolveRiaOnboardingStepId(
  draft: RiaOnboardingDraft,
  preferredStepId?: RiaOnboardingStepId | null,
  options?: RiaOnboardingFlowOptions,
): RiaOnboardingStepId {
  const steps = buildRiaOnboardingSteps(draft, options);
  const normalizedPreferredStepId =
    normalizeRiaOnboardingStepId(preferredStepId);
  if (
    normalizedPreferredStepId &&
    steps.some((step) => step.id === normalizedPreferredStepId)
  ) {
    return normalizedPreferredStepId;
  }
  if (preferredStepId) {
    return steps[0]?.id || "welcome";
  }
  return findFirstIncompleteRiaOnboardingStepId(draft, options);
}

export function findFirstIncompleteRiaOnboardingStepId(
  draft: RiaOnboardingDraft,
  options?: RiaOnboardingFlowOptions,
): RiaOnboardingStepId {
  const steps = buildRiaOnboardingSteps(draft, options);
  const incomplete = steps.find(
    (step) =>
      step.id !== "review" &&
      !canContinueRiaOnboardingStep(step.id, draft, options),
  );
  return incomplete?.id || "review";
}

export function getRiaOnboardingStepIndex(
  draft: RiaOnboardingDraft,
  currentStepId: RiaOnboardingStepId,
  options?: RiaOnboardingFlowOptions,
): number {
  const index = buildRiaOnboardingSteps(draft, options).findIndex(
    (step) => step.id === currentStepId,
  );
  return index >= 0 ? index : 0;
}
