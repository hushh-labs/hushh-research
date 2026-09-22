import profile from "../../config/pkm/kyc-identity-profile.v1.json";

export type KycIdentityField = {
  id: string;
  domain: string;
  path: string;
  aliases: string[];
};

export const KYC_IDENTITY_PROFILE_VERSION = profile.version;
export const KYC_IDENTITY_FIELDS = profile.fields as KycIdentityField[];

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function canonicalKycFieldIds(value: string): string[] {
  const label = normalized(value);
  if (!label) return [];
  return KYC_IDENTITY_FIELDS.filter((field) =>
    [field.id, field.path, ...field.aliases]
      .map(normalized)
      .some((alias) => alias === label || label.includes(alias) || alias.includes(label)),
  ).map((field) => field.id);
}

export function kycFieldsForDomain(domain: string): KycIdentityField[] {
  return KYC_IDENTITY_FIELDS.filter((field) => field.domain === domain.trim().toLowerCase());
}

export function kycAliasesForField(fieldId: string): string[] {
  return KYC_IDENTITY_FIELDS.find((field) => field.id === fieldId)?.aliases ?? [];
}
