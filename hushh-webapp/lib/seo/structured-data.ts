/**
 * Structured data (JSON-LD) for answer-engine optimization (AEO).
 *
 * Builds a schema.org @graph describing the Hussh platform, the website, and
 * the One private agent application. Aligned to the canonical agent ontology
 * (Hussh -> One -> {Kai, Nav, KYC}); see docs/vision/agent-ontology.md.
 */

import {
  absoluteUrl,
  PUBLIC_ROUTES,
  PUBLIC_ROUTE_SEMANTICS,
  SITE_URL,
} from "@/lib/seo/site";

const ORG_ID = `${SITE_URL}/#organization`;
const SITE_ID = `${SITE_URL}/#website`;
const APP_ID = `${SITE_URL}/#software`;
const FOUNDER_ID = `${SITE_URL}/#founder`;

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
          "Hussh is the platform and trust infrastructure for consent-first private AI agents: scoped access, BYOK, zero-knowledge vault, and encrypted PKM.",
        founder: { "@id": FOUNDER_ID },
        sameAs: ["https://hushh.ai", "https://www.hushh.ai"],
      },
      {
        "@type": "WebSite",
        "@id": SITE_ID,
        url: SITE_URL,
        name: "Hussh",
        publisher: { "@id": ORG_ID },
        hasPart: PUBLIC_ROUTES.map((route) => ({ "@id": `${absoluteUrl(route)}#page` })),
      },
      ...PUBLIC_ROUTES.map((route) => ({
        "@type": PUBLIC_ROUTE_SEMANTICS[route].schemaType,
        "@id": `${absoluteUrl(route)}#page`,
        url: absoluteUrl(route),
        name: PUBLIC_ROUTE_SEMANTICS[route].title,
        description: PUBLIC_ROUTE_SEMANTICS[route].description,
        isPartOf: { "@id": SITE_ID },
        publisher: { "@id": ORG_ID },
        ...(PUBLIC_ROUTE_SEMANTICS[route].schemaType === "ProfilePage"
          ? { mainEntity: { "@id": FOUNDER_ID } }
          : {}),
      })),
      {
        "@type": "Person",
        "@id": FOUNDER_ID,
        name: "Manish Sainani",
        url: absoluteUrl("/manishhussh"),
        image: absoluteUrl("/manish-sainani.png"),
        jobTitle: "Founder & CEO",
        worksFor: { "@id": ORG_ID },
        alumniOf: {
          "@type": "CollegeOrUniversity",
          name: "Purdue University",
        },
        description:
          "Founder & CEO of Hussh, building personal agent infrastructure people own: Hussh One and the open consent protocol PCHP.",
        sameAs: [
          "https://www.linkedin.com/in/manishsainani",
          "https://x.com/manish_sainani",
          "https://www.wikidata.org/wiki/Q141478333",
        ],
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
          "One is your top private agent in Hussh. One holds the relationship and delegates specialist work to Kai (finance), Nav (privacy and consent), and KYC (identity).",
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
          "Zero-knowledge vault and encrypted personal information memory",
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
