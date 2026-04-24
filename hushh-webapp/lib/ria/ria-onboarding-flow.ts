"use client";

export type RiaCapability = "advisory" | "brokerage";

export type RiaOnboardingStepId =
  | "capabilities"
  | "display_name"
  | "legal_identity"
  | "advisory_firm"
  | "broker_firm"
  | "public_profile"
  | "review";

export type RiaOnboardingDraft = {
  currentStepId: RiaOnboardingStepId;
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
};

export type RiaOnboardingStep = {
  id: RiaOnboardingStepId;
  eyebrow: string;
  title: string;
  description: string;
};

export type RiaOnboardingFlowOptions = {
  nameVerificationSatisfied?: boolean;
};

const STEP_ORDER: RiaOnboardingStepId[] = [
  "capabilities",
  "display_name",
  "legal_identity",
  "advisory_firm",
  "broker_firm",
  "public_profile",
  "review",
];

function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isRiaOnboardingStepId(value: unknown): value is RiaOnboardingStepId {
  return typeof value === "string" && STEP_ORDER.includes(value as RiaOnboardingStepId);
}

export function normalizeRiaCapabilities(value: unknown): RiaCapability[] {
  const input = Array.isArray(value) ? value : [];
  const set = new Set<RiaCapability>();
  for (const item of input) {
    if (item === "advisory" || item === "brokerage") {
      set.add(item);
    }
  }
  return STEP_ORDER.flatMap((stepId) => {
    if (stepId === "advisory_firm" && set.has("advisory")) return ["advisory"];
    if (stepId === "broker_firm" && set.has("brokerage")) return ["brokerage"];
    return [];
  }) as RiaCapability[];
}

export function createEmptyRiaOnboardingDraft(): RiaOnboardingDraft {
  return {
    currentStepId: "capabilities",
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
  };
}

export function normalizeRiaOnboardingDraft(
  value: Partial<RiaOnboardingDraft> | null | undefined
): RiaOnboardingDraft {
  const base = createEmptyRiaOnboardingDraft();
  return {
    currentStepId: isRiaOnboardingStepId(value?.currentStepId)
      ? value.currentStepId
      : base.currentStepId,
    requestedCapabilities:
      normalizeRiaCapabilities(value?.requestedCapabilities).length > 0
        ? normalizeRiaCapabilities(value?.requestedCapabilities)
        : base.requestedCapabilities,
    displayName: sanitizeText(value?.displayName),
    individualLegalName: sanitizeText(value?.individualLegalName),
    individualCrd: sanitizeText(value?.individualCrd),
    advisoryFirmName: sanitizeText(value?.advisoryFirmName),
    advisoryFirmIapdNumber: sanitizeText(value?.advisoryFirmIapdNumber),
    brokerFirmName: sanitizeText(value?.brokerFirmName),
    brokerFirmCrd: sanitizeText(value?.brokerFirmCrd),
    headline: sanitizeText(value?.headline),
    strategySummary: sanitizeText(value?.strategySummary),
  };
}

export function buildRiaOnboardingSteps(
  draft: RiaOnboardingDraft,
  _options?: RiaOnboardingFlowOptions
): RiaOnboardingStep[] {
  const steps: RiaOnboardingStep[] = [
    {
      id: "capabilities",
      eyebrow: "Capability",
      title: "Which professional lane are you activating first?",
      description:
        "Choose the trust lane Kai should verify. Advisory unlocks the current RIA workflow. Brokerage stays tracked separately.",
    },
    {
      id: "display_name",
      eyebrow: "Identity",
      title: "What name should Kai verify first?",
      description:
        "Enter the advisor name once. Kai verifies it in the background before the rest of the RIA workflow opens.",
    },
  ];

  if (draft.requestedCapabilities.includes("brokerage")) {
    steps.push({
      id: "broker_firm",
      eyebrow: "Broker Firm",
      title: "Which broker-dealer should Kai pair with this capability?",
      description:
        "Brokerage remains a separate verification lane, so we capture the primary broker firm here.",
    });
  }

  steps.push(
    {
      id: "public_profile",
      eyebrow: "Trust Surface",
      title: "What should an investor understand before accepting your invite?",
      description:
        "Keep it short and credible. A strong headline and summary are enough for v1 onboarding.",
    },
    {
      id: "review",
      eyebrow: "Review",
      title: "Review the trust story before you submit it",
      description:
        "Kai will submit the regulatory data for verification and stage the short public profile investors will see first.",
    }
  );

  return steps;
}

export function canContinueRiaOnboardingStep(
  stepId: RiaOnboardingStepId,
  draft: RiaOnboardingDraft,
  options?: RiaOnboardingFlowOptions
): boolean {
  switch (stepId) {
    case "capabilities":
      return draft.requestedCapabilities.length > 0;
    case "display_name":
      return draft.displayName.trim().length > 0 && Boolean(options?.nameVerificationSatisfied);
    case "legal_identity":
      return (
        draft.individualLegalName.trim().length > 0 &&
        draft.individualCrd.trim().length > 0
      );
    case "advisory_firm":
      return (
        draft.advisoryFirmName.trim().length > 0 &&
        draft.advisoryFirmIapdNumber.trim().length > 0
      );
    case "broker_firm":
      return draft.brokerFirmName.trim().length > 0 && draft.brokerFirmCrd.trim().length > 0;
    case "public_profile":
      return (
        draft.headline.trim().length > 0 || draft.strategySummary.trim().length > 0
      );
    case "review":
      return true;
    default:
      return false;
  }
}

export function getRequestedCapabilityLabels(draft: RiaOnboardingDraft): string[] {
  return draft.requestedCapabilities.map((capability) =>
    capability === "advisory" ? "Advisory" : "Brokerage"
  );
}

export function resolveRiaOnboardingStepId(
  draft: RiaOnboardingDraft,
  preferredStepId?: RiaOnboardingStepId | null,
  options?: RiaOnboardingFlowOptions
): RiaOnboardingStepId {
  const steps = buildRiaOnboardingSteps(draft, options);
  if (preferredStepId && steps.some((step) => step.id === preferredStepId)) {
    return preferredStepId;
  }
  if (preferredStepId) {
    return steps[0]?.id || "capabilities";
  }
  return findFirstIncompleteRiaOnboardingStepId(draft, options);
}

export function findFirstIncompleteRiaOnboardingStepId(
  draft: RiaOnboardingDraft,
  options?: RiaOnboardingFlowOptions
): RiaOnboardingStepId {
  const steps = buildRiaOnboardingSteps(draft, options);
  const incomplete = steps.find(
    (step) =>
      step.id !== "review" && !canContinueRiaOnboardingStep(step.id, draft, options)
  );
  return incomplete?.id || "review";
}

export function getRiaOnboardingStepIndex(
  draft: RiaOnboardingDraft,
  currentStepId: RiaOnboardingStepId,
  options?: RiaOnboardingFlowOptions
): number {
  const index = buildRiaOnboardingSteps(draft, options).findIndex((step) => step.id === currentStepId);
  return index >= 0 ? index : 0;
}
