/** Import-safe Wallet Profile draft contract shared by feature validation and
 * the private native presentation. No UI, transport or authentication imports. */
export type WalletCardPreferredContact = "email" | "phone" | "linkedin" | "website";

export type WalletCardFieldKey =
  | "fullName"
  | "username"
  | "headline"
  | "organisation"
  | "locationLabel"
  | "summary"
  | "skills"
  | "email"
  | "phone"
  | "website"
  | "linkedin"
  | "github"
  | "portfolio";

/** Free-text draft. Skills are edited as one comma-separated line. */
export type WalletCardDraft = Record<WalletCardFieldKey, string> & {
  preferredContact: WalletCardPreferredContact;
};

export const EMPTY_WALLET_CARD_DRAFT: WalletCardDraft = {
  fullName: "",
  username: "",
  headline: "",
  organisation: "",
  locationLabel: "",
  summary: "",
  skills: "",
  email: "",
  phone: "",
  website: "",
  linkedin: "",
  github: "",
  portfolio: "",
  preferredContact: "email",
};

/** Field limits mirror contract §3 exactly. */
export const WALLET_CARD_FIELD_LIMITS: Record<WalletCardFieldKey, number> = {
  fullName: 80,
  username: 30,
  headline: 120,
  organisation: 80,
  locationLabel: 80,
  summary: 400,
  // 12 skills x 40 characters, plus the separators the owner types.
  skills: 12 * 41,
  email: 254,
  phone: 32,
  website: 300,
  linkedin: 300,
  github: 300,
  portfolio: 300,
};
