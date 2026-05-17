"use client";

import type { RiaOnboardingDraft } from "@/lib/ria/ria-onboarding-flow";
import type {
  CrdScrapeJobResult,
  RiaLicenseVerificationResult,
} from "@/lib/services/ria-service";

type Textish = string | number | boolean | null | undefined;

const SERVICE_DETECTORS: Array<{ label: string; patterns: RegExp[] }> = [
  {
    label: "Portfolio Management",
    patterns: [
      /\bportfolio management\b/i,
      /\basset management\b/i,
      /\binvestment management\b/i,
      /\binvestment adviser\b/i,
      /\binvestment advisor\b/i,
      /\badvisory services\b/i,
    ],
  },
  {
    label: "Retirement Planning",
    patterns: [/\bretirement\b/i, /\b401\s*\(?k\)?\b/i, /\bpension\b/i],
  },
  {
    label: "Tax Planning",
    patterns: [/\btax planning\b/i, /\btax strategy\b/i],
  },
  {
    label: "Estate Planning",
    patterns: [/\bestate planning\b/i, /\btrust planning\b/i],
  },
];

const FEE_DETECTORS: Array<{ label: string; patterns: RegExp[] }> = [
  {
    label: "Fee-only",
    patterns: [/\bfee[- ]only\b/i],
  },
  {
    label: "AUM %",
    patterns: [
      /\bassets?\s+under\s+management\b/i,
      /\bAUM\b/i,
      /\basset[- ]based\s+fee\b/i,
      /\bpercentage\s+of\s+assets\b/i,
    ],
  },
  {
    label: "Flat",
    patterns: [/\bflat\s+fee\b/i, /\bfixed\s+fee\b/i],
  },
  {
    label: "Hourly",
    patterns: [/\bhourly\b/i],
  },
];

function cleanString(value: Textish): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanNumberString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = cleanString(value as Textish);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function pickExistingOrNext(existing: string, next: string): string {
  return existing.trim() || next.trim();
}

function collectText(value: unknown, depth = 0, output: string[] = []): string[] {
  if (output.length > 80 || depth > 4 || value == null) return output;
  if (typeof value === "string") {
    const text = value.trim();
    if (text) output.push(text.slice(0, 4_000));
    return output;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, depth + 1, output);
    return output;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "summary",
      "broker_intelligence_summary",
      "bio",
      "strategy_summary",
      "textExcerpt",
      "description",
      "status",
      "registrationStatus",
      "firmName",
      "name",
      "category",
      "role",
      "years",
      "location",
      "officialReports",
      "firmHistory",
      "currentEmployments",
      "exams",
      "openWeb",
    ]) {
      collectText(record[key], depth + 1, output);
    }
  }
  return output;
}

function inferOptionsFromText(
  text: string,
  detectors: Array<{ label: string; patterns: RegExp[] }>
): string[] {
  if (!text.trim()) return [];
  return detectors
    .filter(({ patterns }) => patterns.some((pattern) => pattern.test(text)))
    .map(({ label }) => label);
}

function normalizeCertification(value: unknown): string {
  if (!value) return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const category = cleanString(record.category as Textish);
    if (category) return category;
    return normalizeCertification(record.name);
  }
  const text = cleanString(value as Textish);
  if (!text) return "";
  const seriesMatch = text.match(/\bSeries\s*\d+[A-Z]*\b/i);
  if (seriesMatch) return seriesMatch[0].replace(/\s+/, " ");
  if (/\bSIE\b/i.test(text)) return "SIE";
  if (/securities industry essentials/i.test(text)) return "SIE";
  return text.length <= 32 ? text : "";
}

function extractCertifications(
  licenseResult?: RiaLicenseVerificationResult | null,
  scrapeResult?: CrdScrapeJobResult | null
): string[] {
  const report = scrapeResult?.report;
  const values: unknown[] = [
    ...(licenseResult?.certifications || []),
    ...(licenseResult?.exams_passed || []),
    ...(Array.isArray(report?.exams) ? report.exams : []),
  ];
  return uniqueStrings(values.map(normalizeCertification));
}

function extractMinimumEngagement(text: string): string {
  const match = text.match(
    /(?:minimum|min(?:imum)?\s+(?:account|engagement|investment)?)[^$]{0,40}\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i
  );
  return match?.[1]?.trim() || "";
}

function parseDateScore(value: unknown): number {
  const raw = cleanString(value as Textish);
  if (!raw || /present|current/i.test(raw)) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scoreFirmHistoryRow(row: Record<string, unknown>, preferredFirm: string): number {
  const firmName = cleanString(row.firmName as Textish) || cleanString(row.firm as Textish);
  const end = cleanString(row.registrationEndDate as Textish) || cleanString(row.endDate as Textish);
  const begin =
    cleanString(row.registrationBeginDate as Textish) || cleanString(row.beginDate as Textish);
  const scope = `${cleanString(row.firmIapdScope as Textish)} ${cleanString(
    row.firmBrokerCheckScope as Textish
  )}`;
  let score = 0;
  if (preferredFirm && firmName.toLowerCase() === preferredFirm.toLowerCase()) score += 1_000;
  if (!end || /present|current/i.test(end)) score += 500;
  if (/\bACTIVE\b/i.test(scope)) score += 100;
  score += Math.min(parseDateScore(end || begin) / 100_000_000_000, 90);
  return score;
}

function extractBestFirmHistory(
  scrapeResult: CrdScrapeJobResult | null | undefined,
  preferredFirm: string
): Record<string, unknown> | null {
  const rows = scrapeResult?.report?.firmHistory;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .sort(
      (a, b) =>
        scoreFirmHistoryRow(b, preferredFirm) -
        scoreFirmHistoryRow(a, preferredFirm)
    )[0] || null;
}

function extractOfficialLocation(scrapeResult: CrdScrapeJobResult | null | undefined): {
  city: string;
  areaLocality: string;
  pinZip: string;
  fullStreetAddress: string;
} {
  const official = scrapeResult?.report?.officialLocation;
  if (!official || typeof official !== "object" || Array.isArray(official)) {
    return { city: "", areaLocality: "", pinZip: "", fullStreetAddress: "" };
  }
  const record = official as Record<string, unknown>;
  const city = cleanString(record.city as Textish);
  const state = cleanString(record.state as Textish);
  return {
    city,
    areaLocality: state || cleanString(record.location as Textish),
    pinZip:
      cleanString(record.pinZip as Textish) ||
      cleanString(record.pin_zip as Textish) ||
      cleanString(record.zip as Textish) ||
      cleanString(record.postalCode as Textish),
    fullStreetAddress:
      cleanString(record.address as Textish) ||
      cleanString(record.streetAddress as Textish) ||
      cleanString(record.fullStreetAddress as Textish),
  };
}

function buildBio(params: {
  advisorName: string;
  firmName: string;
  crdNumber: string;
  regulatorStatus: string;
  city: string;
  areaLocality: string;
  certifications: string[];
  summary: string;
}): string {
  if (params.summary) return params.summary;
  if (!params.advisorName) return "";

  const segments: string[] = [];
  const normalizedStatus = params.regulatorStatus.toLowerCase();
  const role =
    !normalizedStatus || /^(active|inactive|current|previous)/i.test(normalizedStatus)
      ? normalizedStatus || "a financial professional"
      : `${/^[aeiou]/i.test(normalizedStatus) ? "an" : "a"} ${normalizedStatus}`;
  segments.push(
    `${params.advisorName} is listed as ${role}${
      params.firmName ? ` with ${params.firmName}` : ""
    }.`
  );
  if (params.crdNumber) {
    segments.push(`Public regulatory records list CRD ${params.crdNumber}.`);
  }
  if (params.certifications.length > 0) {
    segments.push(
      `Qualifications include ${params.certifications.slice(0, 4).join(", ")}.`
    );
  }
  const location = [params.city, params.areaLocality].filter(Boolean).join(", ");
  if (location) {
    segments.push(`Primary location: ${location}.`);
  }
  return segments.join(" ");
}

export function buildRiaLicensePrefillPatch(
  draft: RiaOnboardingDraft,
  result: RiaLicenseVerificationResult,
  submittedLicense: string
): Partial<RiaOnboardingDraft> {
  const advisorName = cleanString(result.advisor_name) || draft.advisorName;
  const firmName = cleanString(result.firm_name) || draft.firmName;
  const regulatorStatus = cleanString(result.regulator_status) || draft.regulatorStatus;
  const crdNumber = cleanString(result.crd_number) || submittedLicense || draft.crdNumber;
  const certifications = uniqueStrings([
    ...draft.certifications,
    ...extractCertifications(result, null),
  ]);
  const evidenceText = collectText(result).join("\n");
  const providerServices = uniqueStrings(result.services_offered || []);
  const providerFees = uniqueStrings(result.fee_structure || []);
  const services =
    draft.servicesOffered.length > 0
      ? draft.servicesOffered
      : providerServices.length > 0
        ? providerServices
        : inferOptionsFromText(evidenceText, SERVICE_DETECTORS);
  const fees =
    draft.feeStructure.length > 0
      ? draft.feeStructure
      : providerFees.length > 0
        ? providerFees
        : inferOptionsFromText(evidenceText, FEE_DETECTORS);
  const minEngagementAmount =
    draft.minEngagementAmount ||
    cleanNumberString(result.min_engagement_amount) ||
    extractMinimumEngagement(evidenceText);
  const bio = pickExistingOrNext(
    draft.bio,
    buildBio({
      advisorName,
      firmName,
      crdNumber,
      regulatorStatus,
      city: draft.city,
      areaLocality: draft.areaLocality,
      certifications,
      summary:
        cleanString(result.bio) ||
        cleanString(result.strategy_summary) ||
        cleanString(result.broker_intelligence_summary),
    })
  );

  return {
    licenseVerificationStatus: "found",
    advisorName,
    firmName,
    regulator: cleanString(result.regulator) || draft.regulator,
    regulatorStatus,
    licenseExpiry: cleanString(result.license_expiry) || draft.licenseExpiry,
    certifications,
    city: pickExistingOrNext(draft.city, cleanString(result.city)),
    pinZip: pickExistingOrNext(draft.pinZip, cleanString(result.pin_zip)),
    crdNumber,
    secNumber: cleanString(result.sec_number) || draft.secNumber,
    servicesOffered: services,
    feeStructure: fees,
    minEngagementAmount,
    bio,
    scrapeJobId: cleanString(result.scrape_job_id) || draft.scrapeJobId,
    displayName: advisorName || draft.displayName,
    individualLegalName: advisorName || draft.individualLegalName,
    individualCrd: crdNumber || draft.individualCrd,
    advisoryFirmName: firmName || draft.advisoryFirmName,
    headline:
      draft.headline ||
      (advisorName && firmName ? `${advisorName} at ${firmName}` : advisorName || firmName),
    strategySummary: pickExistingOrNext(draft.strategySummary, bio),
  };
}

export function buildRiaScrapePrefillPatch(
  draft: RiaOnboardingDraft,
  result: CrdScrapeJobResult
): Partial<RiaOnboardingDraft> {
  const report = result.report;
  if (!report) return {};

  const bestFirm = extractBestFirmHistory(result, draft.firmName);
  const officialLocation = extractOfficialLocation(result);
  const city =
    officialLocation.city ||
    cleanString(bestFirm?.city as Textish) ||
    draft.city;
  const areaLocality =
    officialLocation.areaLocality ||
    cleanString(bestFirm?.state as Textish) ||
    draft.areaLocality;
  const firmName =
    draft.firmName ||
    cleanString(bestFirm?.firmName as Textish) ||
    cleanString(bestFirm?.firm as Textish);
  const crdNumber = draft.crdNumber || cleanString(result.crdNumber);
  const certifications = uniqueStrings([
    ...draft.certifications,
    ...extractCertifications(null, result),
  ]);
  const evidenceText = collectText(report).join("\n");
  const services =
    draft.servicesOffered.length > 0
      ? draft.servicesOffered
      : inferOptionsFromText(evidenceText, SERVICE_DETECTORS);
  const fees =
    draft.feeStructure.length > 0
      ? draft.feeStructure
      : inferOptionsFromText(evidenceText, FEE_DETECTORS);
  const bio = pickExistingOrNext(
    draft.bio,
    buildBio({
      advisorName: draft.advisorName || cleanString(report.fullName),
      firmName,
      crdNumber,
      regulatorStatus: draft.regulatorStatus || cleanString(report.registrationStatus),
      city,
      areaLocality,
      certifications,
      summary: "",
    })
  );

  return {
    advisorName: draft.advisorName || cleanString(report.fullName),
    firmName,
    certifications,
    city: pickExistingOrNext(draft.city, city),
    areaLocality: pickExistingOrNext(draft.areaLocality, areaLocality),
    pinZip: pickExistingOrNext(draft.pinZip, officialLocation.pinZip),
    fullStreetAddress: pickExistingOrNext(
      draft.fullStreetAddress,
      officialLocation.fullStreetAddress
    ),
    servicesOffered: services,
    feeStructure: fees,
    minEngagementAmount:
      draft.minEngagementAmount || extractMinimumEngagement(evidenceText),
    bio,
    strategySummary: pickExistingOrNext(draft.strategySummary, bio),
    individualLegalName:
      draft.individualLegalName || draft.advisorName || cleanString(report.fullName),
    individualCrd: draft.individualCrd || crdNumber,
    advisoryFirmName: draft.advisoryFirmName || firmName,
  };
}
