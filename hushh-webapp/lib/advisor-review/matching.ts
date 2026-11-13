/** Explicit service matching only. No inference, network access or model calls. */
export const ADVISOR_SERVICES = [
  {
    id: "portfolio_management",
    label: "Managing my investments",
    service: "Portfolio Management",
  },
  {
    id: "retirement_planning",
    label: "Planning for retirement",
    service: "Retirement Planning",
  },
  {
    id: "tax_planning",
    label: "Planning around taxes",
    service: "Tax Planning",
  },
  {
    id: "estate_planning",
    label: "Estate planning",
    service: "Estate Planning",
  },
] as const;

export type AdvisorService = (typeof ADVISOR_SERVICES)[number]["id"];

const aliases: Record<AdvisorService, readonly string[]> = {
  portfolio_management: [
    "portfolio management",
    "investment management",
    "asset management",
  ],
  retirement_planning: ["retirement planning", "retirement plan consulting"],
  tax_planning: ["tax planning"],
  estate_planning: ["estate planning"],
};

export function normalizeAdvisorService(value: unknown): AdvisorService | null {
  return ADVISOR_SERVICES.some((service) => service.id === value)
    ? (value as AdvisorService)
    : null;
}

export function advisorServiceLabel(service: AdvisorService): string {
  return ADVISOR_SERVICES.find((item) => item.id === service)!.service;
}

export type ServiceCandidate = {
  userId: string;
  personRef: string;
  verified: boolean;
  servicesOffered?: readonly string[];
};

/** Keep the canonical directory's stable tie order; never claim tied matches are better. */
export function matchAdvisorServices<T extends ServiceCandidate>(
  candidates: readonly T[],
  service: AdvisorService,
  ownerUserId: string,
  limit = 5,
): { advisor: T; reason: string }[] {
  const seen = new Set<string>();
  const matches: { advisor: T; reason: string }[] = [];
  const maximum = Number.isFinite(limit)
    ? Math.min(5, Math.max(0, Math.trunc(limit)))
    : 5;
  if (!maximum) return matches;
  for (const advisor of candidates) {
    if (
      advisor.verified !== true ||
      advisor.userId === ownerUserId ||
      !advisor.personRef ||
      seen.has(advisor.personRef)
    )
      continue;
    const offers = advisor.servicesOffered?.some(
      (value) =>
        typeof value === "string" &&
        aliases[service].includes(
          value.trim().replace(/\s+/g, " ").toLowerCase(),
        ),
    );
    if (!offers) continue;
    seen.add(advisor.personRef);
    matches.push({
      advisor,
      reason: `Lists ${advisorServiceLabel(service)} among their services.`,
    });
    if (matches.length === maximum) break;
  }
  return matches;
}
