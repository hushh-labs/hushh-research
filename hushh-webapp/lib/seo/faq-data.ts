import type { FaqItem } from "@/lib/seo/structured-data";

/**
 * Canonical FAQ used for the home-page FAQ JSON-LD. Answers are aligned to the
 * agent ontology (Hussh -> One -> {Kai, Nav, KYC}) and the consent-first model.
 */
export const HOME_FAQ: readonly FaqItem[] = [
  {
    question: "What is Hussh?",
    answer:
      "Hussh is the platform and trust infrastructure for consent-first personal AI agents. It provides scoped access, bring-your-own-key (BYOK), a zero-knowledge vault, and encrypted personal knowledge memory (PKM), so your data stays yours.",
  },
  {
    question: "What is One?",
    answer:
      "One is your top personal agent in Hussh. One holds the relationship: it listens after you grant scope, remembers context, decides across domains, and acts inside consent. One delegates specialist work to Kai, Nav, and KYC.",
  },
  {
    question: "What are Kai, Nav, and KYC?",
    answer:
      "Kai is the finance specialist for portfolio, market intelligence, and investing workflows. Nav is the privacy and consent guardian for scope review, vault, and deletion. KYC is the identity workflow specialist for verification and structured PKM writeback.",
  },
  {
    question: "How does Hussh protect my data?",
    answer:
      "Every read or action happens only after you grant a scoped consent token. Keys are yours through BYOK, the vault is zero-knowledge, and your personal knowledge memory is encrypted. There are no silent reads and no implied platform access.",
  },
  {
    question: "Is Hussh available on mobile?",
    answer:
      "Yes. Hussh One runs on the web and ships native iOS and Android apps, so your personal agent and consent controls travel with you.",
  },
];
