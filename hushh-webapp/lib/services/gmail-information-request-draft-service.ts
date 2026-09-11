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

function valuesForDraft(value: unknown, label: string, depth = 0): string[] {
  if (value === null || value === undefined || depth > 5) return [];
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const text = String(value).trim();
    return text ? [`${label}: ${text}`] : [];
  }
  if (Array.isArray(value)) {
    const scalarValues = value
      .filter((item) => ["string", "number", "boolean"].includes(typeof item))
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 8);
    return scalarValues.length ? [`${label}: ${scalarValues.join(", ")}`] : [];
  }
  if (typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, nested]) =>
      valuesForDraft(
        nested,
        `${label} · ${key.replaceAll("_", " ")}`,
        depth + 1,
      ),
    )
    .slice(0, 20);
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
  const lines: string[] = [];
  const availableLabels = new Map<string, string[]>();

  for (const scope of requestedScopes) {
    const candidate = candidateByScope.get(scope);
    if (!candidate) continue;
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
    const projection = projectDomainDataForScope({
      domain: candidate.domain,
      scope: candidate.scope,
      domainData: snapshot?.data || {},
      approvedPaths: [
        candidate.scope.slice(`attr.${candidate.domain}.`.length),
      ],
    });
    const values = valuesForDraft(
      projection[candidate.domain],
      candidate.label,
    );
    if (values.length) {
      availableLabels.set(
        candidate.label.toLowerCase(),
        candidate.canonical_field_ids || canonicalKycFieldIds(candidate.label),
      );
    }
    lines.push(...values);
  }

  const unavailableLabels = workflow.requested_field_labels.filter((label) => {
    return (
      label.trim() &&
      ![...availableLabels.entries()].some(([availableLabel, canonicalFieldIds]) =>
        isRequestedLabelCovered(label, availableLabel, canonicalFieldIds),
      )
    );
  });
  if (!lines.length) {
    return {
      body: null,
      unavailableLabels:
        unavailableLabels.length > 0
          ? unavailableLabels
          : workflow.requested_field_labels,
    };
  }
  return {
    body: [
      "Hello,",
      "",
      "Here are the requested details:",
      "",
      ...lines,
      "",
      "Please let me know if you need anything else.",
    ].join("\n"),
    unavailableLabels,
  };
}
