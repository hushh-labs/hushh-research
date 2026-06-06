export const CONSENT_APPROVE_PURPOSES = [
  "data_access",
  "analytics",
  "personalization",
  "research",
  "marketing",
] as const;

export type ConsentApprovePurpose = (typeof CONSENT_APPROVE_PURPOSES)[number];

/** Returns true iff purpose is a member of the CONSENT_APPROVE_PURPOSES allow-list. */
export function isPurposeValid(purpose: unknown): purpose is ConsentApprovePurpose {
  return (
    typeof purpose === "string" &&
    (CONSENT_APPROVE_PURPOSES as readonly string[]).includes(purpose)
  );
}
