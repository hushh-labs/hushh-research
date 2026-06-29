import { SITE_URL } from "@/lib/seo/site";

/**
 * /llms.txt
 *
 * An AEO-friendly summary for LLM answer engines. Describes Hussh and the agent
 * ontology (Hussh -> One -> {Kai, Nav, KYC}) in plain text so models can ground
 * answers accurately. Aligned to docs/vision/agent-ontology.md.
 */
export const dynamic = "force-static";

const BODY = `# Hussh

> Hussh is the platform and trust infrastructure for consent-first personal AI agents.
> Scoped access, bring-your-own-key (BYOK), a zero-knowledge vault, and encrypted
> personal knowledge memory (PKM) keep user data private and user-controlled.

## Agent ontology

- Hussh: platform, trust model, consent, scoped access, BYOK, zero-knowledge vault, PKM, developer access, audit.
- One: the top personal agent and relationship layer. One listens (only after scope is granted), remembers, decides across domains, and acts inside consent. One delegates specialist work.
- Kai: finance specialist. Portfolio context, market intelligence, investing and RIA/investor workflows.
- Nav: privacy and consent guardian. Scope review, vault, deletion, suspicious-access explanations.
- KYC: identity workflow specialist. Verification requirements, missing-document state, structured PKM writeback.

## Principles

- Consent-first: every read or action requires a scoped consent token. No silent reads, no implied access.
- Keys are the user's via BYOK; the vault is zero-knowledge; PKM is encrypted.
- One holds the relationship; specialists hold the craft.

## Links

- Home: ${SITE_URL}/
- Get started: ${SITE_URL}/getting-started
- Developers: ${SITE_URL}/developers
- Marketplace: ${SITE_URL}/marketplace
`;

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
