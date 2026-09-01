/**
 * The owner-side draft model for a Wallet Profile.
 *
 * Every key here maps one-to-one onto the server's closed `card_payload`
 * allowlist (contract §3). The server is the authority: it re-validates and
 * REJECTS anything outside the allowlist. This module exists so the owner sees
 * the same limits before saving instead of after, and so the draft can be
 * pre-filled from information the product already holds.
 */

import {
  isAllowedWalletCardUrl,
  type WalletCardPayload,
  type WalletCardPreferredContact,
} from "@/lib/services/wallet-card-service";

export type WalletCardFieldKey =
  | "fullName"
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

export const WALLET_CARD_MAX_SKILLS = 12;
export const WALLET_CARD_MAX_SKILL_LENGTH = 40;

/** The URL fields, which are https-only and share one validator. */
const URL_FIELDS: readonly WalletCardFieldKey[] = [
  "website",
  "linkedin",
  "github",
  "portfolio",
];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const PHONE_SHAPE = /^\+?[0-9][0-9\s().-]{5,}$/;

export interface WalletCardFieldDefinition {
  readonly key: WalletCardFieldKey;
  readonly label: string;
  readonly placeholder: string;
  readonly description?: string;
  readonly multiline?: boolean;
  readonly type?: "email" | "tel" | "url" | "text";
  readonly inputMode?: "email" | "tel" | "url" | "text";
  readonly autoComplete?: string;
}

/** The recommended default set: name, headline, one preferred contact, one link. */
export const WALLET_CARD_RECOMMENDED_FIELDS: readonly WalletCardFieldDefinition[] =
  [
    {
      key: "fullName",
      label: "Name",
      placeholder: "Your name",
    },
    {
      key: "headline",
      label: "Headline (optional)",
      placeholder: "Founder, Hussh",
    },
  ];

const WALLET_CARD_SECONDARY_PROFILE_FIELDS: readonly WalletCardFieldDefinition[] =
  [
    { key: "organisation", label: "Company or college", placeholder: "Hussh" },
    {
      key: "locationLabel",
      label: "Location",
      placeholder: "Bengaluru",
      description: "City or region only. Never a precise location.",
    },
    {
      key: "summary",
      label: "Short summary",
      placeholder: "What you work on, in a couple of sentences.",
      multiline: true,
    },
    {
      key: "skills",
      label: "Skills",
      placeholder: "Product, Privacy engineering, Swift",
      description: `Up to ${WALLET_CARD_MAX_SKILLS}, separated by commas.`,
    },
    {
      key: "github",
      label: "GitHub",
      placeholder: "https://",
      type: "url",
      inputMode: "url",
      autoComplete: "url",
    },
    {
      key: "portfolio",
      label: "Portfolio",
      placeholder: "https://",
      type: "url",
      inputMode: "url",
      autoComplete: "url",
    },
  ];

export type PreferredContactFieldMeta = {
  readonly key: Extract<
    WalletCardFieldKey,
    "email" | "phone" | "linkedin" | "website"
  >;
  readonly label: string;
  readonly placeholder: string;
  readonly type: "email" | "tel" | "url";
  readonly inputMode: "email" | "tel" | "url";
  readonly autoComplete: string;
};

export const PREFERRED_CONTACT_FIELD_META: Record<
  WalletCardPreferredContact,
  PreferredContactFieldMeta
> = {
  email: {
    key: "email",
    label: "Email",
    placeholder: "you@example.com",
    type: "email",
    inputMode: "email",
    autoComplete: "email",
  },
  phone: {
    key: "phone",
    label: "Phone",
    placeholder: "+1 555 0100",
    type: "tel",
    inputMode: "tel",
    autoComplete: "tel",
  },
  linkedin: {
    key: "linkedin",
    label: "LinkedIn profile",
    placeholder: "https://www.linkedin.com/in/your-profile",
    type: "url",
    inputMode: "url",
    autoComplete: "url",
  },
  website: {
    key: "website",
    label: "Public link",
    placeholder: "https://your-site.com",
    type: "url",
    inputMode: "url",
    autoComplete: "url",
  },
};

export const WALLET_CARD_PREFERRED_CONTACT_OPTIONS: ReadonlyArray<{
  value: WalletCardPreferredContact;
  label: string;
  field: WalletCardFieldKey;
}> = [
  { value: "email", label: "Email", field: "email" },
  { value: "phone", label: "Phone", field: "phone" },
  { value: "linkedin", label: "LinkedIn", field: "linkedin" },
  { value: "website", label: "Link", field: "website" },
];

export function getWalletCardPreferredField(
  preferredContact: WalletCardPreferredContact,
): PreferredContactFieldMeta {
  return PREFERRED_CONTACT_FIELD_META[preferredContact];
}

/**
 * Everything behind More Details. The selected primary-contact field is rendered
 * directly below the selector, so it is deliberately excluded here to prevent a
 * second mounted input with the same draft key.
 */
export function getWalletCardMoreDetailsFields(
  preferredContact: WalletCardPreferredContact,
): WalletCardFieldDefinition[] {
  const selectedField = getWalletCardPreferredField(preferredContact).key;
  const secondaryContactFields = WALLET_CARD_PREFERRED_CONTACT_OPTIONS.filter(
    (option) => option.field !== selectedField,
  ).map((option) => {
    const meta = PREFERRED_CONTACT_FIELD_META[option.value];
    return {
      key: meta.key,
      label: meta.label,
      placeholder: meta.placeholder,
      type: meta.type,
      inputMode: meta.inputMode,
      autoComplete: meta.autoComplete,
    };
  });

  return [...secondaryContactFields, ...WALLET_CARD_SECONDARY_PROFILE_FIELDS];
}

export const WALLET_CARD_OPTIONAL_FIELDS: readonly WalletCardFieldDefinition[] =
  getWalletCardMoreDetailsFields("email");

export function countWalletCardMoreDetails(draft: WalletCardDraft): number {
  return getWalletCardMoreDetailsFields(draft.preferredContact).filter(
    (definition) => {
      if (definition.key === "skills")
        return splitSkills(draft.skills).length > 0;
      return draft[definition.key].trim().length > 0;
    },
  ).length;
}

export interface WalletCardIdentityHints {
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly phoneNumber?: string | null;
}

/**
 * Pre-fill a draft from information the product already holds, so a person with
 * a complete profile only has to review it. Never invents a value.
 */
export function buildSmartDefaultDraft(
  identity: WalletCardIdentityHints,
): WalletCardDraft {
  const email = normalise(identity.email);
  const phone = normalise(identity.phoneNumber);
  return {
    ...EMPTY_WALLET_CARD_DRAFT,
    fullName: clamp(
      normalise(identity.displayName),
      WALLET_CARD_FIELD_LIMITS.fullName,
    ),
    email: clamp(email, WALLET_CARD_FIELD_LIMITS.email),
    phone: clamp(phone, WALLET_CARD_FIELD_LIMITS.phone),
    preferredContact: email ? "email" : phone ? "phone" : "email",
  };
}

/** Re-open an existing card for editing without losing anything the owner set. */
export function draftFromPayload(payload: WalletCardPayload): WalletCardDraft {
  return {
    fullName: normalise(payload.full_name),
    headline: normalise(payload.headline),
    organisation: normalise(payload.organisation),
    locationLabel: normalise(payload.location_label),
    summary: normalise(payload.summary),
    skills: (payload.skills ?? [])
      .map((skill) => normalise(skill))
      .filter(Boolean)
      .join(", "),
    email: normalise(payload.email),
    phone: normalise(payload.phone),
    website: normalise(payload.website),
    linkedin: normalise(payload.linkedin),
    github: normalise(payload.github),
    portfolio: normalise(payload.portfolio),
    preferredContact: payload.preferred_contact ?? "email",
  };
}

export type WalletCardValidationErrors = Partial<
  Record<WalletCardFieldKey | "preferredContact", string>
>;

/**
 * Client-side mirror of the server's validation. Returns a message per invalid
 * field; an empty object means the draft is safe to submit.
 */
export function validateDraft(
  draft: WalletCardDraft,
): WalletCardValidationErrors {
  const errors: WalletCardValidationErrors = {};

  for (const key of Object.keys(
    WALLET_CARD_FIELD_LIMITS,
  ) as WalletCardFieldKey[]) {
    if (draft[key].trim().length > WALLET_CARD_FIELD_LIMITS[key]) {
      errors[key] =
        `Keep this under ${WALLET_CARD_FIELD_LIMITS[key]} characters.`;
    }
  }

  const email = draft.email.trim();
  if (email && !EMAIL_SHAPE.test(email)) {
    errors.email = "Enter a valid email address.";
  }

  const phone = draft.phone.trim();
  if (phone && !PHONE_SHAPE.test(phone)) {
    errors.phone = "Enter a valid phone number.";
  }

  for (const key of URL_FIELDS) {
    const value = draft[key].trim();
    // The service owns the one URL rule (https only, no userinfo, no
    // javascript:/data:) so the owner form cannot drift from what the server
    // and the public page enforce.
    if (value && !isAllowedWalletCardUrl(value)) {
      errors[key] = "Use a full https:// link.";
    }
  }

  const skills = splitSkills(draft.skills);
  if (skills.length > WALLET_CARD_MAX_SKILLS) {
    errors.skills = `Keep it to ${WALLET_CARD_MAX_SKILLS} skills.`;
  } else if (
    skills.some((skill) => skill.length > WALLET_CARD_MAX_SKILL_LENGTH)
  ) {
    errors.skills = `Each skill must be under ${WALLET_CARD_MAX_SKILL_LENGTH} characters.`;
  }

  const preferred = WALLET_CARD_PREFERRED_CONTACT_OPTIONS.find(
    (option) => option.value === draft.preferredContact,
  );
  if (preferred && !draft[preferred.field].trim()) {
    errors.preferredContact = `Add a ${preferred.label.toLowerCase()} or pick a different preferred contact.`;
  }

  return errors;
}

export function hasValidationErrors(
  errors: WalletCardValidationErrors,
): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * Project the draft onto the server payload. Empty values are omitted rather
 * than sent as blanks, so the stored card only ever holds what the owner chose.
 */
export function draftToPayload(draft: WalletCardDraft): WalletCardPayload {
  const payload: WalletCardPayload = {};
  assign(
    payload,
    "full_name",
    draft.fullName,
    WALLET_CARD_FIELD_LIMITS.fullName,
  );
  assign(
    payload,
    "headline",
    draft.headline,
    WALLET_CARD_FIELD_LIMITS.headline,
  );
  assign(
    payload,
    "organisation",
    draft.organisation,
    WALLET_CARD_FIELD_LIMITS.organisation,
  );
  assign(
    payload,
    "location_label",
    draft.locationLabel,
    WALLET_CARD_FIELD_LIMITS.locationLabel,
  );
  assign(payload, "summary", draft.summary, WALLET_CARD_FIELD_LIMITS.summary);
  assign(payload, "email", draft.email, WALLET_CARD_FIELD_LIMITS.email);
  assign(payload, "phone", draft.phone, WALLET_CARD_FIELD_LIMITS.phone);
  assign(payload, "website", draft.website, WALLET_CARD_FIELD_LIMITS.website);
  assign(
    payload,
    "linkedin",
    draft.linkedin,
    WALLET_CARD_FIELD_LIMITS.linkedin,
  );
  assign(payload, "github", draft.github, WALLET_CARD_FIELD_LIMITS.github);
  assign(
    payload,
    "portfolio",
    draft.portfolio,
    WALLET_CARD_FIELD_LIMITS.portfolio,
  );

  const skills = splitSkills(draft.skills)
    .slice(0, WALLET_CARD_MAX_SKILLS)
    .map((skill) => skill.slice(0, WALLET_CARD_MAX_SKILL_LENGTH));
  if (skills.length > 0) {
    payload.skills = skills;
  }

  const preferred = WALLET_CARD_PREFERRED_CONTACT_OPTIONS.find(
    (option) => option.value === draft.preferredContact,
  );
  if (preferred && draft[preferred.field].trim()) {
    payload.preferred_contact = preferred.value;
  }

  return payload;
}

/** The plain-language list of what a scan will reveal, in display order. */
export function describeSharedFields(draft: WalletCardDraft): string[] {
  const shared: string[] = [];
  if (draft.fullName.trim()) shared.push("Name");
  shared.push("Photo");
  if (draft.headline.trim()) shared.push("Headline");
  if (draft.organisation.trim()) shared.push("Company or college");
  if (draft.locationLabel.trim()) shared.push("Location");
  if (draft.summary.trim()) shared.push("Short summary");
  if (splitSkills(draft.skills).length > 0) shared.push("Skills");
  if (draft.email.trim()) shared.push("Email");
  if (draft.phone.trim()) shared.push("Phone");
  if (draft.website.trim()) shared.push("Public link");
  if (draft.linkedin.trim()) shared.push("LinkedIn");
  if (draft.github.trim()) shared.push("GitHub");
  if (draft.portfolio.trim()) shared.push("Portfolio");
  return shared;
}

export function splitSkills(value: string): string[] {
  return value
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function assign(
  payload: WalletCardPayload,
  key: keyof WalletCardPayload,
  value: string,
  limit: number,
): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  Object.assign(payload, { [key]: trimmed.slice(0, limit) });
}

function normalise(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function clamp(value: string, limit: number): string {
  return value.slice(0, limit);
}
