import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { projectDomainDataForScope } from "@/lib/personal-knowledge-model/manifest";
import { canonicalKycFieldIds } from "@/lib/pkm/kyc-identity-field-registry";
import type {
  GmailInformationRequestCandidateScope,
  GmailInformationRequestWorkflow,
} from "@/lib/services/gmail-information-requests-service";

type ScopedGmailInformationRequest = Pick<
  GmailInformationRequestWorkflow,
  "requested_field_labels" | "candidate_scopes"
>;

export function isExactGmailInformationRequestCandidate(
  candidate: GmailInformationRequestCandidateScope,
): boolean {
  const domain = candidate.domain.trim().toLowerCase();
  const scope = candidate.scope.trim().toLowerCase();
  const prefix = `attr.${domain}.`;
  const path = scope.startsWith(prefix) ? scope.slice(prefix.length) : "";
  return (
    Boolean(domain) &&
    /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(path) &&
    !path.includes("*") &&
    candidate.segment_ids.length === 1 &&
    /^[a-z0-9_]{1,64}$/.test(
      candidate.segment_ids[0]?.trim().toLowerCase() || "",
    )
  );
}

type RecipientSafeFact = {
  label: string;
  value: string;
  canonicalFieldIds: readonly string[];
};

/**
 * The projection has already enforced the exact approved path. This helper
 * intentionally returns values only: PKM domain names, segment names and
 * nested field paths are implementation details and must never reach an email
 * recipient.
 */
function scalarValuesForDraft(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined || depth > 5) return [];
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => scalarValuesForDraft(item, depth + 1))
      .slice(0, 8);
  }
  if (typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>)
    .flatMap((nested) => scalarValuesForDraft(nested, depth + 1))
    .slice(0, 8);
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
}

function factKey(fact: RecipientSafeFact): string {
  return [
    ...fact.canonicalFieldIds.map((fieldId) => fieldId.toLowerCase()),
    fact.label.toLowerCase(),
  ].join(" ");
}

function firstFact(
  facts: RecipientSafeFact[],
  terms: readonly string[],
): RecipientSafeFact | undefined {
  return facts.find((fact) => {
    const key = factKey(fact);
    return terms.some((term) => key.includes(term));
  });
}

function recipientSafeKycReply(facts: RecipientSafeFact[]): string {
  const used = new Set<RecipientSafeFact>();
  const take = (terms: readonly string[]) => {
    const fact = firstFact(facts.filter((candidate) => !used.has(candidate)), terms);
    if (fact) used.add(fact);
    return fact;
  };
  const value = (fact: RecipientSafeFact) => `**${escapeMarkdown(fact.value)}**`;
  const sentences = ["Thank you for your email."];

  const fullName = take(["full_name", "full name", "legal_name", "legal name"]);
  if (fullName) sentences.push(`My name is ${value(fullName)}.`);

  const academicStatus = take(["academic_status", "academic status", "student status"]);
  if (academicStatus) sentences.push(`I am currently a ${value(academicStatus)}.`);

  const programme = take(["programme", "program", "degree", "course"]);
  const department = take(["department"]);
  const institution = take(["institution", "university", "college"]);
  if (programme || department || institution) {
    const education = [
      programme ? `pursuing ${value(programme)}` : "studying",
      department ? `in ${value(department)}` : "",
      institution ? `at ${value(institution)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    sentences.push(`I am ${education}.`);
  }

  const schoolLocation = take(["school_location", "school location"]);
  if (schoolLocation) sentences.push(`I completed my schooling in ${value(schoolLocation)}.`);

  for (const fact of facts) {
    if (used.has(fact)) continue;
    const label = fact.label.replace(/\s+/g, " ").trim();
    if (!label) continue;
    sentences.push(`My **${escapeMarkdown(label)}** is ${value(fact)}.`);
  }

  return [
    "Hello,",
    "",
    sentences.join(" "),
    "",
    "Please let me know if you need any other details.",
  ].join("\n");
}

/**
 * The classifier's request labels are intentionally human-readable, while
 * manifest labels can be more specific (for example "Full name" or
 * "Educational institution"). Treat those as the same requested field only
 * when their meaningful normalized terms overlap. This is display-label
 * normalization; the actual information remains limited to the exact,
 * consented candidate scope above.
 */
function normalizedLabelTerms(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/educational/g, "education")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(
      (term) =>
        term.length > 1 &&
        !["details", "detail", "information", "requested", "personal"].includes(
          term,
        ),
    );
}

function isRequestedLabelCovered(
  requestedLabel: string,
  availableLabel: string,
  availableCanonicalFieldIds: readonly string[] = [],
): boolean {
  const requestedCanonical = canonicalKycFieldIds(requestedLabel);
  if (
    requestedCanonical.length > 0 &&
    requestedCanonical.some((fieldId) => availableCanonicalFieldIds.includes(fieldId))
  ) {
    return true;
  }
  const requested = normalizedLabelTerms(requestedLabel);
  const available = normalizedLabelTerms(availableLabel);
  if (!requested.length || !available.length) return false;
  if (requested.join(" ") === available.join(" ")) return true;
  return requested.some((term) => available.includes(term));
}

export async function prepareScopedGmailInformationRequestDraft({
  workflow,
  userId,
  vaultKey,
  vaultOwnerToken,
  scopes,
}: {
  workflow: ScopedGmailInformationRequest;
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  /** Defaults to every exact candidate available for this request. */
  scopes?: string[];
}): Promise<{ body: string | null; unavailableLabels: string[] }> {
  const candidates = workflow.candidate_scopes.filter(
    isExactGmailInformationRequestCandidate,
  );
  const requestedScopes = scopes ?? candidates.map((candidate) => candidate.scope);
  const candidateByScope = new Map(
    candidates.map((candidate) => [candidate.scope, candidate]),
  );
  const selectedCandidates = requestedScopes
    .map((scope) => candidateByScope.get(scope))
    .filter((candidate): candidate is GmailInformationRequestCandidateScope =>
      Boolean(candidate),
    );
  const snapshots = new Map<string, Awaited<ReturnType<typeof PkmDomainResourceService.getStaleFirst>>>();
  const candidatesBySegment = new Map<
    string,
    GmailInformationRequestCandidateScope
  >();
  for (const candidate of selectedCandidates) {
    const key = `${candidate.domain.trim().toLowerCase()}::${[...candidate.segment_ids]
      .map((segmentId) => segmentId.trim().toLowerCase())
      .sort()
      .join(",")}`;
    if (!candidatesBySegment.has(key)) candidatesBySegment.set(key, candidate);
  }

  await Promise.all(
    [...candidatesBySegment.entries()].map(async ([key, candidate]) => {
      const snapshot = await PkmDomainResourceService.getStaleFirst({
        userId,
        domain: candidate.domain,
        segmentIds: candidate.segment_ids,
        vaultKey,
        vaultOwnerToken,
        // KYC onboarding can have completed moments before this draft begins.
        // Never let an older decrypted segment make the agent claim details are missing.
        forceRefresh: true,
        backgroundRefresh: false,
      });
      snapshots.set(key, snapshot);
    }),
  );

  const facts: RecipientSafeFact[] = [];
  const availableLabels = new Map<string, string[]>();

  for (const candidate of selectedCandidates) {
    const key = `${candidate.domain.trim().toLowerCase()}::${[...candidate.segment_ids]
      .map((segmentId) => segmentId.trim().toLowerCase())
      .sort()
      .join(",")}`;
    const snapshot = snapshots.get(key);
    const projection = projectDomainDataForScope({
      domain: candidate.domain,
      scope: candidate.scope,
      domainData: snapshot?.data || {},
      approvedPaths: [
        candidate.scope.slice(`attr.${candidate.domain}.`.length),
      ],
    });
    const values = scalarValuesForDraft(projection[candidate.domain]);
    const uniqueValues = [...new Set(values)].slice(0, 8);
    if (uniqueValues.length) {
      availableLabels.set(
        candidate.label.toLowerCase(),
        candidate.canonical_field_ids || canonicalKycFieldIds(candidate.label),
      );
      facts.push({
        label: candidate.label,
        value: uniqueValues.join(", "),
        canonicalFieldIds:
          candidate.canonical_field_ids || canonicalKycFieldIds(candidate.label),
      });
    }
  }

  const unavailableLabels = workflow.requested_field_labels.filter((label) => {
    return (
      label.trim() &&
      ![...availableLabels.entries()].some(([availableLabel, canonicalFieldIds]) =>
        isRequestedLabelCovered(label, availableLabel, canonicalFieldIds),
      )
    );
  });
  if (!facts.length) {
    return {
      body: null,
      unavailableLabels:
        unavailableLabels.length > 0
          ? unavailableLabels
          : workflow.requested_field_labels,
    };
  }
  return {
    body: recipientSafeKycReply(facts),
    unavailableLabels,
  };
}
