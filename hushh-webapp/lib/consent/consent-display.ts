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

