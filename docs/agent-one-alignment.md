# Agent One — One Spine, Three Faces, One Human

A cross‑repo alignment north star. Working backwards from the human being served, it maps how every Hushh repo is (or should be) one thing: **Agent One serving a person, on consent, with a receipt** — from the front door a stranger walks through, to the daily surface that gets things done, to the newsfeed their life becomes.

> Grounding & honesty on depth. Deeply reviewed this cycle: `hushh-research` (Agent One / One·Kai·Nav, consent protocol, PKM/vault, consumer webapp) and `hussh-dev-platform` (developer platform). Oriented this turn: `hushh-search-console` (public front door — README, docs index, routes, hero copy, `ENTERPRISE_SSO.md`, `AGENT_ARCHITECTURE.md`). Known from the wiki: `hussh-one-hermes` (the production Agent One runtime), `hushh-agents`, `hushh-ria-intelligence-api`, `hussh-mulesoft-delivery`. Where I say "aligned/needs alignment" I cite a file; where I'm summarizing intent I say so.

---

## 1. Start with the human (work backwards from here)

Everything below only earns its place if it serves one person's day. The human at the center has:

- **Basic day‑to‑day preferences** — how they like things done, said, timed.
- **Basic privacy preferences** — what they'll share, with whom, for how long.
- **Daily favorites** — the places, brands, and things they love and trust.
- **Their people** — the ones they follow, love, and want to keep an eye on: an **inner circle** (family, caregivers, closest) and an **outer circle** (colleagues, community, the wider trusted web).
- **A need to stay aware** — to know how the people and things they care about are doing, without drowning in noise or surrendering their privacy to get it.

**Today** Hushh One is *Agent One that helps them get things done.* **Over time**, if the product is genuinely good, that same surface becomes their **Hushh newsfeed**: a consented stream of **connections, communication, and commerce** across their whole life and trusted circle — inbound from the people and brands they've allowed, curated by their own agent, never by an ad auction. The newsfeed is not a new app; it is what Agent One *becomes* once the trust is real.

Design rule that follows from this: **no capability ships unless you can name the human moment it serves.** (This mirrors the repo's own agent‑ontology rule — "name the One handoff, specialist owner, consent scope, vault boundary, action route.")

---

## 2. The one spine

There is exactly one product, and it is **Agent One** — the private agent the human owns. Under it sit specialists (Kai = finance, Nav = privacy/consent, KYC = identity, and developer‑built ones). Beneath everything is **one trust spine**: identity → consent → scoped exchange → receipt (the consent protocol, expressed publicly as **PCHP**: *Ask. Approve. Audit.*).

```
                          the human (owns the key, the vault, the circle)
                                        │
                                   Agent One  ── Nav (consent/privacy guardian)
                        ┌───────────────┼───────────────┐
                     specialists     the vault       the receipt ledger
                    (Kai, KYC, dev)   (PKM, BYOK)     (transparency log)
                                        │
                        ── ONE consent spine: PCHP / consent tokens ──
```

The spine is what makes the three faces *the same product* instead of three apps that share a logo.

---

## 3. The three faces of Agent One (each mapped to real repos)

Agent One meets three different audiences — but it must feel like **one** thing to the human, because it is *their* agent in every case.

| Face | Who it serves | What it is | Where it lives (repo) |
|---|---|---|---|
| **Consumer** | the human, daily | One·Kai·Nav: get things done; hold the vault/PKM; the daily surface (and the future newsfeed) | `hushh-research/hushh-webapp` + `consent-protocol`; runtime in `hussh-one-hermes` |
| **Developer** | builders | build specialist agents that attach to Agent One and receive only Nav‑approved context | `hussh-dev-platform` (MCP, SDK, sandbox) |
| **Enterprise / brand** | brands, agents, institutions, the world | how the world *reaches* the human — through the consent handshake, at the front door, with a receipt (Ping, Button, Flow, SSO, vertical surfaces) | `hushh-search-console` (public front door) + PCHP |

**The consumer face** is the point. The other two exist to make the consumer's life richer *without* breaching the spine: developers add capability the human can summon; brands earn a consented way to serve (not surveil) the human.

**The enterprise/brand face is more built than it looks.** `hushh-search-console` already ships:
- **Ping** — "consent‑first reachability": anyone (person, app, agent, bot) sends a friendly hello to your 🤫 spaceID; *your* Agent One decides what to share back, scoped to the moment, with a receipt. "Machines that want to serve you come to the front door and knock; you decide who comes in." **This is the inbound primitive of the newsfeed.**
- **Save‑my‑Soul** — one‑press emergency reach to a pre‑consented trusted circle.
- Dozens of `/one/*` vertical/brand surfaces (federal, defense, insurance, health, household, communities, enterprise, campaigns…) — the AEO/SEO + brand landing layer that meets people where they already are.
- **Enterprise & government SSO** — see §5; already coded.
- A **Google ADK + Hermes agentic‑search** architecture (`docs/AGENT_ARCHITECTURE.md`) — the same ADK/Hermes runtime family as the production Agent One.

---

## 4. The funnel: how a stranger becomes a served human

Working backwards from "the human is being served," the acquisition path is already shaped:

```
public AI search / Ping / vertical landing (hushh-search-console)
   → anonymous value first (two-chat gate: taste before you sign in)
      → sign in with the identity they already carry (Google, Apple, or work/gov SSO)
         → claim your Agent One  →  set consent + start the vault (PKM)
            → Agent One gets things done (Kai, Nav, drafting, connections…)
               → trust compounds  →  the consented Hushh newsfeed
```

Two Apple‑bar notes on this funnel:
1. **The front door already leads with value, not a wall** (the two‑chat anonymous gate; Ping's "taste before signup"). The core app's front door should match that generosity (see the experience review — deep‑links currently hit a credential wall).
2. **"Meet the customer where they are" is literally the SSO story** — let a person arrive with the identity they already own (work, government, Google, Apple). That is built in the front door and missing in the core app. Aligning them *is* the day‑0 launch requirement.

---

## 5. The alignment gaps (dev‑platform ↔ research ↔ search‑console)

The three faces are drifting apart in exactly the places where they must be one. Ranked by leverage:

### G1 — One consent protocol, spoken three ways *(highest)*
The spine is forked into dialects:
- `hushh-research`: **HCT** tokens (`HCT:` HMAC), scopes `attr.{domain}.{key}` / `cap.*` / `agent.*`.
- `hussh-dev-platform`: **CRT** (Consent Receipt Token), `grant_id`, six‑phase handshake.
- `hushh-search-console`: **PCHP** (Ping, "identity, consent, scoped exchange, receipt").
These are the *same protocol at different maturity tiers* — the webapp itself reconciles them as "HCT baseline + CRT/DAT target profiles" (`hushh-webapp/lib/research/pchp-spec.ts`). **Action:** publish one versioned consent contract (envelope + scope taxonomy + error codes) as a shared package all three repos import; make PCHP the public name, HCT the shipped baseline, CRT/DAT the target profile. Until this lands, "seamless across surfaces" is prose, not code.

### G2 — Enterprise/government SSO is built in the front door, missing in the core app *(day‑0 blocker)*
`hushh-search-console/docs/ENTERPRISE_SSO.md` + `src/lib/auth/sso-providers.ts` + `signInWithSso()` already implement SAML/OIDC via Firebase **Identity Platform** (Microsoft/Entra, Okta, Salesforce, Amazon, Login.gov, ID.me) with a provider‑agnostic server verifier — "turning a provider on is a console step plus one env var; no code change." Meanwhile `hushh-research` runs plain Firebase Google/Apple with **no** Identity Platform / SAML / OIDC / tenant wiring (`hushh-webapp/lib/services/auth-service.ts`; backend `consent-protocol/api/utils/firebase_auth.py` verifies tokens but is not tenant‑aware). **Action for day‑0:** (a) upgrade the core app's Firebase project to Identity Platform; (b) port the `sso-providers` registry + `signInWithSso` redirect‑first flow into `hushh-webapp` and its native shell; (c) make the backend verifier tenant‑aware. This is *porting proven code across our own repos*, not greenfield. (Note honestly: "Apple One / Google One subscription‑tier gating" is **not** feasible — neither platform exposes a user's Apple One/Google One status to third‑party apps; use the subscription you *can* verify, your own, and IdP entitlements for enterprise.)

### G3 — The developer's agent can't actually attach to One yet *(the platform's own promise)*
`hussh-dev-platform` lets a developer build/validate/run a specialist in a sandbox, but production Agent One's roster is hardcoded in `hushh-research` with no out‑of‑repo attach path (documented in `docs/reviews/*` last cycle). The human only benefits when a developer‑built specialist can be summoned by *their* One. **Action:** promote the generated agent registry to runtime and have registration emit the MCP wiring (the "automatic MCP mapping" already asked for).

### G4 — One name, one voice *(cheap, everywhere)*
"Hussh / Hushh / Hussh One / Agent One / One" drift across all repos and even within files. Pick one (**Hussh** brand; **One / Agent One** product per the ontology and NN‑01/NN‑02) and enforce it with a lint. The front door already uses "🤫 Agent One" confidently; the core app should match.

### G5 — Vocabulary at the trust surface *(in progress)*
Internal nouns ("scope code", "PKM", "VAPID", "KYC") were bleeding onto consumer trust screens; the experience review's iteration 1 removed the worst in `hushh-research`. The same enforcement should span the front door and dev portal.

---

## 6. The newsfeed north star (what it all becomes)

The newsfeed is the destination that makes the three faces obviously one product. It is the human's **consented inbound life**, curated by their own agent:

| Newsfeed strand | Inbound source | The consent primitive | Face that feeds it |
|---|---|---|---|
| **Connections** | people in the inner + outer circle ask to reach / share | **Ping** → One answers by the rules you set, with a receipt | enterprise/brand front door + consumer |
| **Communication** | trusted people & agents send scoped updates ("how are they doing") | scoped, revocable grants; Nav mediates | consumer + Ping |
| **Commerce** | brands the human loves respond to *consented* intent, never ad surveillance | **Flow / Button** (brands answer a scoped query) → CRT‑scoped exchange | enterprise/brand |
| **Their own agents** | One / Kai / specialists surface "here's what I noticed / did" | the vault + transparency log | consumer + developer |

Sequencing (honest): **connections and awareness first** (Ping is the wedge — it already exists), **communication next**, **commerce last** (it requires the most trust and the Flow/Button + certification rails). Ship the newsfeed only *after* Agent One is genuinely good at getting things done — trust is the prerequisite, not the launch feature. The feed is earned, not front‑loaded.

---

## 7. The alignment plan (sequenced, in service of the human)

1. **One consent contract package** (G1) — the shared PCHP/HCT envelope + scope taxonomy + error codes, imported by all three repos. Everything else rides on this.
2. **Day‑0 SSO parity** (G2) — port the search‑console SSO into the core app + Identity Platform + tenant‑aware verifier, so a person arrives with the identity they already own. *This is the launch requirement you raised.*
3. **The attach path** (G3) — runtime agent registry + auto MCP mapping, so developer specialists reach the human's One.
4. **One name, one voice, one trust vocabulary** (G4, G5) — brand + microcopy lint across all repos.
5. **Ping as the newsfeed wedge** — harden Ping's consent + receipt loop in the core app (it's the one inbound primitive that already embodies the whole vision), then grow the feed strand by strand (connections → communication → commerce).

Each step is measured the Hushh way: does a real person, on their phone, feel *met, in control, and served* — with a receipt they alone can read?

---

## Appendix — the ecosystem at a glance

| Repo | Role in the one spine |
|---|---|
| `hushh-research` | Core: Agent One (One·Kai·Nav), consent protocol, PKM/vault, consumer webapp + iOS |
| `hussh-one-hermes` | The production Agent One runtime (Hermes fork; ADK, Vertex, WhatsApp/voice channels) |
| `hushh-search-console` | Public front door: AI search, Ping, Save‑my‑Soul, vertical/brand surfaces, enterprise/gov SSO |
| `hussh-dev-platform` | Developer face: build specialist agents for Agent One (MCP, SDK, sandbox) |
| `hushh-agents` | Agent implementations / ADK (agent library) |
| `hushh-ria-intelligence-api` | RIA/advisor verification intelligence (Kai's advisor lane) |
| `hussh-mulesoft-delivery` | Salesforce/MuleSoft enterprise delivery |
| `consent-protocol` | The trust spine as a standalone (mirrored into research) |

The test of alignment is simple: **can you trace any surface in any repo back to a single human moment, through the one consent spine, ending in a receipt only that human can read?** Where you can, it's aligned. Where you can't, it's drift.
