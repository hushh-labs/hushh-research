export type KaiLegalDocumentType = "terms" | "privacy";

type KaiLegalSection = {
  title: string;
  points: string[];
};

type KaiLegalDocument = {
  title: string;
  summary: string;
  updatedAt: string;
  sections: KaiLegalSection[];
};

export const KAI_LEGAL_DOCUMENTS: Record<KaiLegalDocumentType, KaiLegalDocument> = {
  terms: {
    title: "Terms",
    summary:
      "These terms summarize current Agent Kai product policy from project docs and are subject to formal legal review updates.",
    updatedAt: "February 2026",
    sections: [
      {
        title: "Educational Use Only",
        points: [
          "Agent Kai is an educational and informational tool and is not investment advice.",
          "Agent Kai is not a registered investment adviser with the SEC or any state securities regulator.",
          "Always consult a licensed financial professional before making investment decisions.",
        ],
      },
      {
        title: "Not Fund Advisory Services",
        points: [
          "Agent Kai is not part of Hushh Technology Fund L.P.'s investment advisory or fund management services.",
          "Kai does not solicit for Hushh Technology Fund L.P. or any investment product.",
        ],
      },
      {
        title: "Operational Boundaries",
        points: [
          "Kai does not manage portfolios or execute trades.",
          "Risk personas are user-selected and transparency is provided through decision receipts and audit trails.",
        ],
      },
      {
        title: "Legal Entity Status",
        points: [
          "Operating-entity legal naming and final legal paperwork are documented as pending legal review.",
        ],
      },
    ],
  },
  privacy: {
    title: "Privacy Policy",
    summary:
      "This policy reflects the current documented privacy architecture: BYOK encryption, consent-first access, and user-controlled data handling.",
    updatedAt: "February 2026",
    sections: [
      {
        title: "Data Ownership & Encryption",
        points: [
          "Hussh uses BYOK: encryption keys stay with the user, and servers store ciphertext only.",
          "Personal Knowledge Model storage is encrypted (AES-256-GCM) and decrypted on the client.",
          "Sensitive credentials remain in memory and are not persisted as long-term browser storage.",
        ],
      },
      {
        title: "Consent-First Access",
        points: [
          "All protected data access requires a consent token; signed-in identity alone is not sufficient.",
          "Vault-owner flows are consent-gated and all consent operations are auditable.",
        ],
      },
      {
        title: "Privacy Commitments",
        points: [
          "Privacy by default is a core product goal, including on-device processing support.",
          "Data minimization and transparency are explicit compliance targets in current docs.",
          "Users have documented right-to-know and right-to-delete expectations for stored data history.",
        ],
      },
      {
        title: "Compliance Scope",
        points: [
          "Current references include CCPA/CPRA and GDPR-aligned design goals, with implementation details evolving through ongoing compliance work.",
        ],
      },
    ],
  },
};
