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

export function buildRiaOnboardingSteps(draft: RiaOnboardingDraft): RiaOnboardingStep[] {
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
      title: "What name should investors recognize immediately?",
      description:
        "This is the public name carried into discovery, invites, and consent surfaces.",
    },
    {
      id: "legal_identity",
      eyebrow: "Verification",
      title: "Who should Kai verify against regulator records?",
      description:
        "We use your legal name and individual CRD to fail closed before any advisor workflow goes live.",
    },
  ];

  if (draft.requestedCapabilities.includes("advisory")) {
    steps.push({
      id: "advisory_firm",
      eyebrow: "Advisory Firm",
      title: "Which advisory firm should Kai verify with your profile?",
      description:
        "Use the primary registered advisory firm and IAPD/IARD number investors should trust.",
    });
  }

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
  draft: RiaOnboardingDraft
): boolean {
  switch (stepId) {
    case "capabilities":
      return draft.requestedCapabilities.length > 0;
    case "display_name":
      return draft.displayName.trim().length > 0;
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
  preferredStepId?: RiaOnboardingStepId | null
): RiaOnboardingStepId {
  const steps = buildRiaOnboardingSteps(draft);
  if (preferredStepId && steps.some((step) => step.id === preferredStepId)) {
    return preferredStepId;
  }
  if (preferredStepId) {
    return steps[0]?.id || "capabilities";
  }
  return findFirstIncompleteRiaOnboardingStepId(draft);
}

export function findFirstIncompleteRiaOnboardingStepId(
  draft: RiaOnboardingDraft
): RiaOnboardingStepId {
  const steps = buildRiaOnboardingSteps(draft);
  const incomplete = steps.find((step) => step.id !== "review" && !canContinueRiaOnboardingStep(step.id, draft));
  return incomplete?.id || "review";
}

export function getRiaOnboardingStepIndex(
  draft: RiaOnboardingDraft,
  currentStepId: RiaOnboardingStepId
): number {
  const index = buildRiaOnboardingSteps(draft).findIndex((step) => step.id === currentStepId);
  return index >= 0 ? index : 0;
}
