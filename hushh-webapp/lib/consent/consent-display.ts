"use client";

type ConsentDisplayInput = {
  scope?: string | null;
  scopeDescription?: string | null;
  reason?: string | null;
  additionalAccessSummary?: string | null;
  kind?: string | null;
  isScopeUpgrade?: boolean | null;
  existingGrantedScopes?: string[] | null;
};

type ConsentRequesterLabelInput = {
  requesterLabel?: string | null;
  counterpartLabel?: string | null;
  developer?: string | null;
  counterpartEmail?: string | null;
  counterpartSecondaryLabel?: string | null;
  counterpartId?: string | null;
  agentId?: string | null;
};

const UUID_LIKE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstNonEmptyLabel(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return null;
}

function isTechnicalRequesterIdentity(value: string | null | undefined): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith("ria:")) return true;
  if (UUID_LIKE_PATTERN.test(normalized)) return true;
  if (!normalized.includes("@") && !normalized.includes(" ") && normalized.length >= 20) {
    return true;
  }
  return false;
}

export function humanizeConsentScope(scope: string | null | undefined): string {
  const normalized = String(scope || "").trim();
  if (!normalized) return "Consent request";

  const attrMatch = normalized.match(/^attr\.([a-zA-Z0-9_]+)(?:\.(.*))?$/);
  if (attrMatch?.[1]) {
    const domain = attrMatch[1].replace(/_/g, " ");
    const tail = String(attrMatch[2] || "").trim();
    if (!tail || tail === "*") {
      return `${domain.replace(/\b\w/g, (char) => char.toUpperCase())} data`;
    }
    return `${domain} ${tail}`
      .replace(/[._]/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  if (normalized === "vault.owner") return "Full vault access";
  if (normalized === "pkm.read") return "Personal Knowledge Model access";
  if (normalized === "pkm.write") return "Personal Knowledge Model updates";

  return normalized
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveConsentSupportingCopy(input: ConsentDisplayInput): string {
  if (input.additionalAccessSummary) return input.additionalAccessSummary;
  if (input.scopeDescription) return input.scopeDescription;
  if (input.reason) return input.reason;
  if (input.kind === "invite") return "Invitation waiting for investor approval.";
  if (input.isScopeUpgrade && (input.existingGrantedScopes?.length || 0) > 0) {
    return "Additional access is requested beyond what is already approved.";
  }
  return humanizeConsentScope(input.scope);
}

export function resolveConsentRequesterLabel(
  input: ConsentRequesterLabelInput
): string {
  const friendlyLabel = firstNonEmptyLabel(
    [
      input.requesterLabel,
      input.counterpartLabel,
      input.developer,
      input.counterpartEmail,
      input.counterpartSecondaryLabel,
    ].filter((value) => !isTechnicalRequesterIdentity(value))
  );
  if (friendlyLabel) return friendlyLabel;

  if (
    String(input.agentId || "").trim().toLowerCase().startsWith("ria:") ||
    isTechnicalRequesterIdentity(input.counterpartId)
  ) {
    return "Connected advisor";
  }

  return (
    firstNonEmptyLabel([
      input.counterpartId,
      input.agentId,
    ]) || "Requester"
  );
}
