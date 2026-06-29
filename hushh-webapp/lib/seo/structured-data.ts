/**
 * Structured data (JSON-LD) for answer-engine optimization (AEO).
 *
 * Builds a schema.org @graph describing the Hussh platform, the website, and
 * the One personal agent application. Aligned to the canonical agent ontology
 * (Hussh -> One -> {Kai, Nav, KYC}); see docs/vision/agent-ontology.md.
 */

import { absoluteUrl, SITE_URL } from "@/lib/seo/site";

const ORG_ID = `${SITE_URL}/#organization`;
const SITE_ID = `${SITE_URL}/#website`;
const APP_ID = `${SITE_URL}/#software`;

export function buildOrganizationGraph(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORG_ID,
        name: "Hussh",
        url: SITE_URL,
        logo: absoluteUrl("/quiet-emoji-icon.png"),
        description:
          "Hussh is the platform and trust infrastructure for consent-first personal AI agents: scoped access, BYOK, zero-knowledge vault, and encrypted PKM.",
        sameAs: ["https://hushh.ai"],
      },
      {
        "@type": "WebSite",
        "@id": SITE_ID,
        url: SITE_URL,
        name: "Hussh",
        publisher: { "@id": ORG_ID },
      },
      {
        "@type": "SoftwareApplication",
        "@id": APP_ID,
        name: "Hussh One",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web, iOS, Android",
        url: SITE_URL,
        publisher: { "@id": ORG_ID },
        description:
          "One is your top personal agent in Hussh. One holds the relationship and delegates specialist work to Kai (finance), Nav (privacy and consent), and KYC (identity).",
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
        featureList: [
          "One: relationship layer and specialist handoffs",
          "Kai: finance, portfolio, and market intelligence",
          "Nav: privacy, consent, and vault guardian",
          "KYC: identity workflow specialist",
          "Consent-first scoped access with BYOK",
          "Zero-knowledge vault and encrypted PKM",
        ],
      },
    ],
  };
}

export interface FaqItem {
  question: string;
  answer: string;
}

export function buildFaqGraph(items: readonly FaqItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}
