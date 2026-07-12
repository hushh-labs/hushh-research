/**
 * PCHP — Personal Consent Handshake Protocol — Specification v0.1
 * (protocol version string: pchp/2026-07-12)
 *
 * Authored by the 🤫 Research & Intelligence Team. Original content, authored
 * in the information architecture pioneered by the Model Context Protocol
 * (Anthropic), which in turn credits the Language Server Protocol (Microsoft).
 * We stand on that lineage gratefully — see the Acknowledgements section.
 *
 * This file is the single source of the rendered spec. Sections are authored as
 * GitHub-flavored Markdown so the spec stays easy to read, easy to diff, and
 * easy to fork. Normative keywords (MUST / SHOULD / MAY) follow RFC 2119 / BCP 14.
 *
 * Grounding: the normative statements here describe the Hussh Consent Protocol
 * as shipped in the consent-protocol backend (HCT tokens, scope grammar,
 * event-sourced audit, zero-knowledge scoped export) unified with the
 * Personal Consent Handshake north-star (CRT / DAT / Transparency Log /
 * ephemeral envelope). Conformance levels below state honestly what is SHIPPED
 * versus PROPOSED for v1.
 */

export const PCHP_PROTOCOL_VERSION = "pchp/2026-07-12";
export const PCHP_SPEC_SEMVER = "0.1.0";
export const PCHP_STATUS = "Public Request for Comments";

export type PchpSpecSection = {
  id: string;
  label: string;
  eyebrow: string;
  summary: string;
  body: string;
};

export const PCHP_SPEC_SECTIONS: PchpSpecSection[] = [
  {
    id: "overview",
    label: "Overview",
    eyebrow: "Specification",
    summary:
      "What PCHP is, who it is for, and the one idea it standardizes: consent on every read of personal data.",
    body: `PCHP (Personal Consent Handshake Protocol) is an open standard for sharing personal data between a person, the agents that work for them, and the humans and machines they choose to trust — with **consent and control built into every single transaction**.

Think of PCHP as a **signed receipt and a revocable key attached to every share of your data**. Before anything private moves, a handshake happens: the requester says exactly what they want and why, the owner approves (or declines) with a real credential, a scoped and time-boxed key is issued, the data moves inside a sealed envelope, and every step is written to a log the owner can read. When the owner revokes, the key dies.

This specification defines the authoritative protocol requirements. The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described in [BCP 14](https://datatracker.ietf.org/doc/html/bcp14) ([RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119), [RFC 8174](https://datatracker.ietf.org/doc/html/rfc8174)) when, and only when, they appear in all capitals.

## What PCHP enables

Working backwards from the person and the job they are trying to get done:

- **Share your financial health in seconds, not weeks.** Give your CPA, tax preparer, lawyer, auditor, or banker exactly the data they need — a scoped, time-boxed, revocable read — instead of emailing statements and losing track of who has what.
- **Let your agent act for you, safely.** An agent (yours or one you have delegated to) can request, hold, and use a consent grant on your behalf, and you retain complete visibility and a kill switch.
- **Be the owner, always.** The owner is a human, or a machine that human governs. Ownership means visibility into every action and the ability to revoke it.
- **Prove it happened.** Every grant, every read, every revocation is an event in a transparency log the owner can audit.

## Why PCHP matters, by who you are

- **Owners (individuals):** your personal data stops leaking into inboxes and portals. Every share is consented, scoped, logged, and revocable.
- **Agents:** a standard way to ask for and hold consent, so an agent can be a genuinely useful super-assistant without becoming a liability.
- **Requesters (CPAs, banks, apps, auditors):** a standard way to ask for exactly what you need and receive it in a verifiable, least-privilege envelope — with a receipt that stands up to compliance review.
- **Developers:** build once against an open protocol; integrate everywhere it is honored.

## Adjacent standards (what PCHP is *not*)

PCHP is deliberately narrow. It is the **consent handshake layer**, and it composes with the standards below rather than replacing them:

- It is **not OAuth**. OAuth authorizes an application against a provider; PCHP obtains a person's consent for a specific read of *their own* data and issues a receipt for it. PCHP uses OAuth-family primitives where useful.
- It is **not OpenID**. Identity/authentication is an input to the handshake, not the handshake.
- It is **not DRM**. PCHP protects the owner's control over their data, not a vendor's control over the owner.

If MCP is a standardized way to connect AI applications to tools and context, PCHP is the standardized way to connect a **person's private data** to the humans and agents they trust — with consent as the protocol, not a checkbox.`,
  },
  {
    id: "stack",
    label: "Where PCHP Sits",
    eyebrow: "Specification",
    summary:
      "How PCHP fits the secure networking stack alongside TCP/IP, TLS/HTTPS, and the 2026 agent-protocol wave (x402, PACT, OAuth for agents).",
    body: `The internet already has handshakes for the layers below consent. **TCP/IP** gets the packets there. **TLS/HTTPS** encrypts them and proves *who the server is*. In 2026 a new wave of protocols is racing to give autonomous agents the rest of what they need to transact — payment, access, and identity:

- **x402** (Cloudflare with AWS and Stripe) settles *payments* for agents at the edge.
- **PACT — Private Access Control Tokens** (Cloudflare with Chrome, Firefox, and Edge) proves *a visitor is a legitimate human or authorized bot* without tracking them.
- **OAuth for agents** (now generally available on major platforms) handles *application authorization* with scoped, revocable permissions.

Each of these answers a real question. **None of them answers the one PCHP does:** did the human owner consent to this specific read of their own private data — scoped, logged, and revocable? Payment is not consent. Bot-verification is not consent. Application-authorization is not the owner's consent over their own data.

PCHP is proposed as **the consent handshake for the secure networking stack** — the layer that sits alongside TLS the way encryption sits alongside transport. TLS is the *encryption* handshake; PCHP is the *consent* handshake. It **composes with** x402, PACT, and OAuth rather than competing with them: an agent can be paid (x402), proven legitimate (PACT), and app-authorized (OAuth), and *still* need a PCHP receipt before it reads a single field of a person's private data.

\`\`\`
  Application data / agents
  ─────────────────────────────────────────────
  PCHP    ← consent handshake  (may this party read THIS person's data? scoped + revocable)
  TLS     ← encryption handshake (is the channel private? who is the server?)
  TCP/IP  ← transport            (do the packets arrive?)
\`\`\`

## Why propose it at the protocol layer

Consent implemented per-app is consent that does not travel. Every product reinvents it, none of them interoperate, and the person's control ends at each app's boundary. Proposed as a protocol — with a discovery document, a negotiated handshake, a portable receipt, and a conformance suite — consent becomes something the whole network can honor, the way any server can speak TLS. That is the difference between a feature and infrastructure.

If MCP proved the value of a well-documented open protocol, and the 2026 agent-protocol wave is wiring up payment and access, PCHP fills the human-shaped hole at the top of that stack: **consent, owned by the person.**`,
  },
  {
    id: "architecture",
    label: "Architecture",
    eyebrow: "Specification",
    summary:
      "The participant roles, the trust boundary, and the design principles PCHP is built on.",
    body: `PCHP follows an **owner-centric, issuer-mediated** architecture. Every read of personal data completes a handshake mediated by a single issuing authority the owner trusts, and every grant is attributable to an exact, revocable receipt.

## Roles

| Role | Who it is | Responsibility |
| --- | --- | --- |
| **Owner** | A human, or a machine that human governs | Holds the master authority over a vault of personal data; approves or declines every grant; can revoke at any time. |
| **Agent** | Software acting for the owner (e.g. an orchestrator, a finance agent) | Requests, holds, and uses consent grants on the owner's behalf, strictly within granted scope. |
| **Guardian** | A privacy/consent agent role | Reviews requests against the owner's standing preferences and surfaces them for decision; never a second decision-maker over the owner. |
| **Requester** | An external human or machine (CPA, bank, app, another agent) | Asks for a specific, scoped read and receives a sealed, time-boxed result. |
| **Issuer** | The consent authority the owner trusts | The single signing authority that mints and validates receipts and access tokens and appends to the transparency log. |
| **Transparency Log** | An append-only audit record | Records every REQUESTED / GRANTED / DENIED / REVOKED / READ event for the owner to inspect. |
| **Host** | The socket that exposes owner data under PCHP | "Human Secure Socket Host" — the surface (cloud or local device) that serves data reads only against a valid handshake. |

The trust boundary is drawn at the **owner and their issuer**. Requesters and their agents live *outside* the boundary and can only obtain scoped, time-boxed, revocable reads through the handshake — never standing access to the vault.

## Design principles

1. **Consent is the protocol, not a checkbox.** No personal data read completes without a valid, owner-attributable consent receipt. This is a protocol-level requirement, not an application-level courtesy.
2. **Least privilege, always time-boxed.** Every grant is scoped to the narrowest useful resource and expires. Read-once flows SHOULD default to short lifetimes.
3. **The owner can always see and always revoke.** Visibility and revocation are first-class, not features. Revocation MUST invalidate outstanding access tokens across the system.
4. **The issuer holds keys; requesters hold receipts.** Requesters never receive the owner's keys — only scoped tokens and sealed envelopes.
5. **Attributable by construction.** Every grant maps to an exact receipt id; every read maps to an exact grant. State is always explainable.
6. **Vendor-neutral (bring-your-own-agent).** PCHP MUST NOT require a specific model, agent, or cloud. Neutrality is what lets the protocol be trusted infrastructure rather than a lock-in.
7. **Ease of adoption is a requirement.** A conforming implementation SHOULD be approachable in an afternoon: one discovery document, one handshake, one token to validate.

## The trust boundary, drawn

\`\`\`
        ── owner trust boundary ──────────────┐
        │  Owner  ──approves──▶  Issuer        │
        │    ▲                     │  mints     │
        │    │ visibility/revoke   ▼            │
        │  Agent (owner's)   Transparency Log   │
        └──────────────────────────┬───────────┘
                                    │ scoped, time-boxed,
                                    │ revocable receipt + sealed envelope
                                    ▼
                Requester (CPA / bank / app / agent)  ── outside the boundary
\`\`\``,
  },
  {
    id: "lifecycle",
    label: "Handshake Lifecycle",
    eyebrow: "Base Protocol",
    summary:
      "The six-phase consent handshake: Discover, Hello, Offer, Consent, Deliver, Acknowledge — with version negotiation.",
    body: `PCHP defines a rigorous handshake for every consent-mediated read. Like MCP's connection lifecycle, it negotiates version and capabilities up front and terminates in an auditable, acknowledged state. The handshake has six phases.

\`\`\`
Requester        Issuer / Host          Owner (+ Guardian)      Transparency Log
   │                  │                        │                       │
   │─ 1 Discover ────▶│                        │                       │
   │◀─ capabilities ──│                        │                       │
   │─ 2 Hello ───────▶│  (version + scope ask) │                       │
   │◀─ 3 Offer ───────│─ surface request ─────▶│                       │
   │                  │                        │─ approve/decline ─┐   │
   │                  │◀─ 4 Consent (receipt) ──────────────────────┘   │
   │                  │─ append REQUESTED/GRANTED ─────────────────────▶│
   │◀─ 5 Deliver ─────│  (sealed envelope + access token)              │
   │─ 6 Acknowledge ─▶│─ append READ ─────────────────────────────────▶│
\`\`\`

## Phase 1 — Discover

The requester **MUST** begin by fetching the host's discovery document at a well-known location (see Transports). The discovery document **MUST** declare the supported protocol version(s), the issuer endpoint, the scope families available, and the supported token profiles. A requester that does not support any advertised protocol version **SHOULD** abort.

## Phase 2 — Hello (version + capability negotiation)

The requester **MUST** send a \`hello\` naming: the protocol version it intends to use, the requester's verifiable identity, the exact scopes requested, and the purpose string. The version sent **SHOULD** be the latest the requester supports. If the issuer supports it, the issuer **MUST** proceed on that version; otherwise it **MUST** respond with a version it does support, and the requester **SHOULD** disconnect if it cannot match.

Requesters **SHOULD** request the minimum scopes necessary (principle of least privilege). Issuers **MAY** respond with an \`insufficient_scope\`-style challenge naming the scopes required for a given resource, enabling incremental step-up rather than over-broad up-front asks.

## Phase 3 — Offer

The issuer **MUST** surface the request to the owner (optionally pre-screened by a Guardian against the owner's standing preferences) as a human-legible offer: who is asking, exactly what, for how long, and why. The offer **MUST NOT** be auto-approved on the owner's behalf unless the owner has a standing, revocable rule that explicitly authorizes it, and even then the grant **MUST** be logged identically.

## Phase 4 — Consent

If the owner approves, the issuer **MUST** mint a **Consent Receipt** (see Consent & Tokens) that binds: the owner (as a privacy-preserving subject anchor, never raw PII), the exact scopes, issuance and expiry times, a unique receipt id, and — where the token profile requires it — an attestation of the owner's approval credential (e.g. a passkey/biometric assertion). The issuer **MUST** append \`REQUESTED\` and \`CONSENT_GRANTED\` (or \`CONSENT_DENIED\`) events to the transparency log. A declined offer terminates the handshake here.

## Phase 5 — Deliver

For each read, the issuer **MUST** derive a **Data Access Token** from the receipt, scoped to a single resource and expiring no later than the receipt. The requested data **MUST** be delivered inside an **ephemeral, sealed envelope** — encrypted such that only the intended requester can open it — and the host **MUST NOT** serve the data on any path that lacks a valid access token. Delivery **MUST** be recorded.

## Phase 6 — Acknowledge

The requester **SHOULD** acknowledge receipt, and the issuer **MUST** append a \`READ\` event to the transparency log. The handshake is now complete and fully attributable: an outside observer with the owner's audit view can reconstruct exactly what was shared, with whom, under which receipt, and when.

## Revocation and expiry (out-of-band, any time)

The owner **MAY** revoke a receipt at any time. Revocation **MUST** invalidate the receipt and all access tokens derived from it, **MUST** be honored across instances (not just a single node's cache), and **MUST** append a \`REVOKED\` event. Expiry is enforced identically: an expired receipt or access token **MUST** be rejected. This mirrors the shipped cross-instance revocation check in the reference implementation.

## Timeouts and errors

Implementations **SHOULD** set timeouts on every phase. A conforming issuer **MUST** return a typed error for: unsupported version, unknown or malformed scope, expired or revoked credential, and insufficient scope. Sensitive failures **MUST NOT** leak whether a subject exists.`,
  },
  {
    id: "consent-tokens",
    label: "Consent & Tokens",
    eyebrow: "Base Protocol",
    summary:
      "The receipt and access-token wire formats, the scope grammar, and the JSON Schema — the normative core.",
    body: `PCHP defines two credential families and one scope grammar. This section is the normative wire contract.

## Token families

- **Consent Receipt (CR).** Owner-authorized, time-bound proof that consent was granted for a set of scopes. In the shipped baseline profile this is the **Hushh Consent Token (HCT)**; in the target profile it is the **Consent Receipt Token (CRT)** with an approval attestation. A CR is minted once per grant (Phase 4).
- **Data Access Token (DAT).** A single-resource, single-read token *derived from* a Consent Receipt (Phase 5). A DAT's expiry **MUST** be less than or equal to its receipt's expiry, and a DAT **MUST** reference the receipt it was derived from.

### Baseline profile — HCT (SHIPPED)

The reference implementation ships a compact, HMAC-signed receipt with a stable wire format and a cross-language golden-vector conformance suite:

\`\`\`
HCT:base64url(user|agent|scope|issued_at|expires_at[|commercial]).HMAC-SHA256-hex
\`\`\`

- Fields are pipe-delimited inside the base64url payload; the signature is a detached HMAC-SHA256 over the exact payload bytes.
- A five-field payload is the legacy form; a sixth literal field \`commercial\` marks a commercial-use grant and, when present, **MUST** be part of the signed bytes.
- Conforming implementations **MUST** reproduce the published golden vectors (currently pinned as \`version: 1\`, validated by both a Python and a Swift implementation). The golden-vector suite is the de-facto cross-language contract; a new implementation is conformant at the baseline profile if and only if it matches every vector.

### Target profile — CRT / DAT (PROPOSED for v1)

The target profile strengthens the baseline for high-assurance flows:

- **Signature:** detached **Ed25519** over a canonical **CBOR** encoding (replacing HMAC for public verifiability).
- **Subject:** a privacy-preserving anchor (e.g. a hash of a phone+email anchor) — **NEVER** raw PII.
- **Attestation:** the receipt binds an owner approval credential — \`nonce\`, \`device_id\`, and a \`biometric_class\` of \`face\` | \`touch\` | \`passcode\` (WebAuthn/passkey PRF in the reference implementation).
- **Lifetimes:** read-once flows default to a 60-second receipt lifetime.

## Scope grammar (normative)

A scope is a lowercase, dotted string matching:

\`\`\`
^[a-z][a-z0-9._*-]{1,127}$
\`\`\`

Scopes are hierarchical and support a trailing wildcard. Two scope kinds are defined:

- **Static scopes** — a fixed catalog (e.g. \`vault.owner\`, \`portfolio.read\`, \`pkm.read\`, agent scopes such as \`agent.kai.*\`, capability scopes such as \`cap.location.live.view\`).
- **Dynamic attribute scopes** — \`attr.{domain}.{key}\`, \`attr.{domain}.*\`, and \`attr.{domain}.{intent}.*\` (e.g. \`attr.identity.*\` for a KYC read). A conforming validator **MUST** resolve a requested scope against the catalog and the dynamic grammar, and **MUST** treat \`domain.*\` as granting every \`domain.key\` beneath it and nothing above it.

A grant **MUST** be rejected if any requested scope fails the grammar, is not in the resolvable set, or exceeds what the owner approved.

## JSON Schema (v0)

The wire format for the target-profile CR and DAT is published as a JSON Schema. It is a request-for-comment reference, not yet implementation-frozen:

\`\`\`json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://hushh.ai/schemas/pchp/v0/tokens.json",
  "title": "PCHP Token Wire Format (v0)",
  "$defs": {
    "ConsentReceipt": {
      "type": "object",
      "required": ["version","sub","scope","iat","exp","jti","sig"],
      "properties": {
        "version": { "const": "pchp/v0" },
        "sub": { "type": "string", "description": "Privacy-preserving subject anchor. NEVER raw PII." },
        "scope": { "type": "array", "items": { "type": "string" } },
        "iat": { "type": "integer" },
        "exp": { "type": "integer", "description": "Default 60s for read-once flows." },
        "jti": { "type": "string", "description": "Receipt id (UUIDv7)." },
        "attest": {
          "type": "object",
          "required": ["nonce","device_id","biometric_class"],
          "properties": {
            "nonce": { "type": "string" },
            "device_id": { "type": "string" },
            "biometric_class": { "enum": ["face","touch","passcode"] }
          }
        },
        "sig": { "type": "string", "description": "Detached Ed25519 over canonical CBOR." }
      }
    },
    "DataAccessToken": {
      "type": "object",
      "required": ["version","cr_jti","resource","envelope_id","exp","sig"],
      "properties": {
        "version": { "const": "pchp/v0" },
        "cr_jti": { "type": "string" },
        "resource": { "type": "string" },
        "envelope_id": { "type": "string" },
        "exp": { "type": "integer", "description": "Always <= ConsentReceipt.exp." },
        "sig": { "type": "string" }
      }
    }
  },
  "oneOf": [{ "$ref": "#/$defs/ConsentReceipt" }, { "$ref": "#/$defs/DataAccessToken" }]
}
\`\`\`

## Delegation (TrustLinks)

An owner **MAY** delegate a scope to an agent via a signed **TrustLink** (\`from_agent | to_agent | scope | created_at | expires_at | signed_by_user | session_id\` + signature). A TrustLink **MUST** be signed only by the issuer on the owner's authority, **MUST** be scoped and time-boxed, and **MUST** be revocable on the same footing as a receipt.`,
  },
  {
    id: "sealed-envelope",
    label: "Sealed Envelope",
    eyebrow: "Base Protocol",
    summary:
      "The zero-knowledge delivery envelope: how data moves so only the intended requester can open it.",
    body: `PCHP delivers data inside an **ephemeral, sealed envelope** so that the reading party — and only the reading party — can open it, and the host never needs to hold the plaintext.

## Requirements

- Personal data at rest in the owner's vault **MUST** be encrypted with an owner-controlled key (bring-your-own-key). The reference implementation uses **AES-256-GCM** with server-stored ciphertext only; the server never holds the vault key.
- For delivery, the payload **MUST** be sealed to the requester such that only the requester's private key can open it. The reference implementation performs a **zero-knowledge scoped export**: the export key is wrapped to the connector's **X25519** public key and the payload is encrypted with **AES-256-GCM**; the connector decrypts locally. The issuer stores and transits ciphertext only.
- The envelope **MUST** carry an \`envelope_id\` referenced by the Data Access Token, so a delivery is bound to exactly one grant and one read.
- Envelopes **SHOULD** be ephemeral. A conforming host **SHOULD NOT** retain a decryptable copy after delivery.

## Capability envelopes

For live or streaming capabilities (e.g. a time-boxed live-location share), PCHP defines **capability envelopes**: a per-grant signed token scoped to the capability (\`cap.*\`), delivered over an ECDH (P-256) + AES-256-GCM channel. Capability grants **MUST** be independently revocable and **MUST** expire.

> Zero-knowledge is the point: the owner's privacy does not depend on trusting the host to behave. The host cannot read what it only ever holds as ciphertext sealed to someone else's key.`,
  },
  {
    id: "transparency-log",
    label: "Transparency Log",
    eyebrow: "Base Protocol",
    summary:
      "The append-only audit record that makes every grant, read, and revocation visible to the owner.",
    body: `Every consent-mediated action **MUST** be recorded in an append-only **Transparency Log** that the owner can inspect. This is what turns "we asked for consent" from a claim into a verifiable fact.

## Event model

The log is **event-sourced**: consent state is the fold over an ordered event stream, not a mutable flag. A conforming implementation **MUST** record at least:

| Event | When |
| --- | --- |
| \`REQUESTED\` | A requester asks for scopes (Phase 2). |
| \`CONSENT_GRANTED\` | The owner approves; a receipt is minted (Phase 4). |
| \`CONSENT_DENIED\` | The owner declines. |
| \`READ\` | Data is delivered against an access token (Phase 5–6). |
| \`REVOKED\` | The owner revokes a receipt. |

Each event **MUST** carry: a timestamp, the receipt id it pertains to, the requester identity, the scopes involved, and enough metadata to reconstruct the decision — but **MUST NOT** store the personal data payload itself.

## Owner visibility

The owner **MUST** be able to retrieve their own handshake history — pending requests, granted/denied decisions, active grants, and revocations. The reference implementation exposes this as a consent handshake history and a consent center; a conforming implementation **MUST** provide an equivalent owner-facing audit view.

## Integrity (PROPOSED for v1)

A v1-conformant log **SHOULD** be tamper-evident — e.g. a hash-chained or Merkle-sealed record so that the owner (or a third party the owner authorizes) can verify the log has not been altered after the fact. This is proposed, not yet shipped, and is tracked as an enhancement proposal.`,
  },
  {
    id: "transports",
    label: "Transports & Discovery",
    eyebrow: "Base Protocol",
    summary:
      "How a requester discovers a host and where the handshake runs: the .well-known/hussh document and HTTP binding.",
    body: `PCHP is transport-agnostic in principle and defines an **HTTPS binding** as the baseline.

## Discovery

A host **MUST** publish a discovery document at a well-known location:

\`\`\`
GET https://<host>/.well-known/hussh
\`\`\`

The document **MUST** declare:

- \`protocol_versions\`: the PCHP versions supported (e.g. \`["pchp/2026-07-12"]\`).
- \`issuer\`: the endpoint that mints and validates receipts and access tokens.
- \`scopes_supported\`: the scope families/catalog available.
- \`token_profiles\`: which token profiles are offered (\`hct\` baseline, \`crt\` target).
- \`log\`: the owner-facing transparency endpoint.

A requester **MUST** treat the discovery document as authoritative for version and capability negotiation, and **MUST NOT** assume capabilities that are not advertised.

## HTTP binding

- All PCHP endpoints **MUST** be served over HTTPS.
- A protected read returns \`401\` when no valid access token is presented and \`403\` for insufficient scope; a \`403\` **SHOULD** name the scopes required, so a requester can step up without guessing.
- Access tokens **MUST** be presented in the \`Authorization\` header and **MUST NOT** appear in a URI query string.
- An access token **MUST** be bound to the specific host it is issued for; a host **MUST** reject a token minted for a different audience, and **MUST NOT** pass a token it received through to an upstream service.

The reference implementation exposes the developer-facing handshake as a versioned \`/api/v1\` flow (discover → request → poll → approve → scoped-export), which is the concrete HTTPS realization of Phases 1–6.

## Machine-readable adoption

A host **SHOULD** also publish an \`llms.txt\` index of its PCHP documentation. Ease of adoption applies to agents as much as to humans: an agent should be able to read how to complete a handshake as easily as a developer can.`,
  },
  {
    id: "security",
    label: "Security & Trust",
    eyebrow: "Specification",
    summary:
      "The threat model and the normative security requirements every conforming implementation must meet.",
    body: `PCHP moves a person's most sensitive data. Security is not an appendix; it is the reason the protocol exists. This section states the normative requirements and the threats they answer.

## Key principles

1. **Owner consent and control.** No personal-data read completes without an owner-attributable consent receipt. Owners **MUST** be able to see and revoke every grant.
2. **Data minimization.** Requests **MUST** be scoped to the narrowest useful resource and **MUST** be time-boxed. Broad or open-ended scopes **SHOULD** be refused.
3. **Zero-knowledge delivery.** The host **MUST NOT** be required to hold plaintext; data is delivered sealed to the requester (see Sealed Envelope).
4. **Attributability.** Every grant and read **MUST** be reconstructable from the transparency log.

## Normative requirements

- **Signing keys** are held only by the issuer. Receipts and TrustLinks **MUST** be signed only by the issuer on the owner's authority.
- **Revocation MUST be global.** A revoked receipt **MUST** be rejected across every instance, not merely evicted from one node's cache. The reference implementation validates active-token state against a shared store, not just an in-memory cache.
- **Audience binding.** An access token **MUST** be validated as issued specifically for the host presenting it; cross-audience token reuse and token pass-through **MUST** be rejected (confused-deputy prevention).
- **Approval credentials.** The target profile **MUST** bind an owner approval attestation (passkey/biometric assertion) to the receipt; the baseline profile **MUST** at minimum bind an authenticated owner session.
- **No PII in identifiers.** The subject anchor and all identifiers **MUST NOT** contain raw PII.
- **Secrets never transit the client-visible path.** Access tokens **MUST NOT** be placed in URLs, logs, or query strings.

## Threats addressed

| Threat | Mitigation |
| --- | --- |
| Standing access / over-collection | Scoped, time-boxed, revocable grants; least privilege at Hello. |
| Stolen token replayed elsewhere | Audience binding; short lifetimes; global revocation. |
| Host compromise leaking data | Zero-knowledge sealed envelope; ciphertext-only at rest and in transit. |
| Silent or deniable sharing | Append-only transparency log with owner visibility. |
| Confused deputy | No token pass-through; per-audience tokens; per-grant consent. |
| Impersonated requester | Verifiable requester identity in Hello; issuer validation before Offer. |

## Honesty about the frontier

Some advertised strengthenings are **proposed, not yet shipped**: Merkle/hash-chained log sealing, threshold signing of high-value grants, and a brand-side settlement endpoint. A conforming implementation **MUST NOT** claim these unless it implements them; the spec tracks them as enhancement proposals so the roadmap is legible rather than aspirational.`,
  },
  {
    id: "conformance",
    label: "Conformance",
    eyebrow: "Specification",
    summary:
      "The two conformance levels, what each requires, and how an implementation proves it conforms.",
    body: `PCHP defines two conformance levels so that implementers can adopt incrementally and state honestly what they support. An implementation **MUST NOT** advertise a level it does not meet.

## Level 1 — Baseline (SHIPPED)

A Level 1 implementation:

- Completes the six-phase handshake over the HTTPS binding.
- Issues **HCT** consent receipts and derives per-read **Data Access Tokens**.
- Enforces the scope grammar (static catalog + \`attr.*\` dynamic scopes) with least-privilege refusal.
- Records the full event set in an owner-visible transparency log.
- Enforces expiry and **global revocation**.
- Delivers reads inside a zero-knowledge sealed envelope.
- **Reproduces every published golden vector.** This is the objective conformance test for the token layer.

The Hussh reference implementation is Level 1 today.

## Level 2 — High-assurance (PROPOSED for v1)

A Level 2 implementation additionally:

- Issues **CRT** receipts: Ed25519 over canonical CBOR, with a bound passkey/biometric approval attestation.
- Provides a tamper-evident (hash-chained or Merkle-sealed) transparency log.
- Supports capability envelopes for live/streaming grants.

## How you prove conformance

1. **Golden vectors.** Match the published token golden-vector suite (Level 1) — the same suite the reference implementation cross-checks in two languages.
2. **Handshake conformance profile.** Complete the published Discover→Acknowledge sequence against the reference test host and produce a well-formed transparency log.
3. **Schema validation.** Validate emitted receipts and access tokens against the published JSON Schema.

A conformance badge is meaningful only against a version. Implementations **MUST** state the protocol version (\`${"pchp/2026-07-12"}\`) and level they conform to.`,
  },
  {
    id: "versioning",
    label: "Versioning & Changelog",
    eyebrow: "Specification",
    summary:
      "How PCHP versions, negotiates, and evolves without breaking the ecosystem.",
    body: `PCHP uses **date-based protocol versioning**, following the approach MCP proved works for a fast-moving open protocol.

## Version string

The protocol version is a date string: **\`pchp/2026-07-12\`**. The specification document additionally carries a semantic version (\`${"0.1.0"}\`) for editorial tracking. The wire/protocol version is what implementations negotiate; the semver is for humans tracking the prose.

## Negotiation

Version is negotiated in the handshake (Phase 2 — Hello) and advertised in discovery (Phase 1). A requester **MUST** send the version it intends to use; the issuer **MUST** answer on that version if supported, or name one it does support. This makes version skew a handled, typed condition rather than a silent failure.

## Compatibility policy

- **Additive changes** (new optional scopes, new token-profile fields behind a capability) **MAY** ship within a version.
- **Breaking changes** (wire-format changes, removed fields, changed semantics) **MUST** mint a new dated version, and hosts **SHOULD** support the previous version for a deprecation window.
- Deprecations **MUST** be announced through the enhancement-proposal process (see Contributing) with a stated timeline.

## Changelog

| Version | Date | Status | Notes |
| --- | --- | --- | --- |
| \`pchp/2026-07-12\` (spec \`0.1.0\`) | 2026-07-12 | Public Request for Comments | First unified public specification: six-phase handshake, HCT baseline + CRT/DAT target profiles, scope grammar, zero-knowledge envelope, transparency log, two conformance levels. Consolidates the shipped Hussh Consent Protocol with the Personal Consent Handshake north-star. |

This is a **request for comments**. The wire formats in the target profile are explicitly not frozen; the golden-vector baseline is stable. We are publishing early and in the open precisely so the standard is shaped by its adopters.`,
  },
  {
    id: "governance",
    label: "Contributing & Governance",
    eyebrow: "Community",
    summary:
      "How PCHP evolves in the open: the Protocol Enhancement Proposal (PEP) process, design principles, and how to participate.",
    body: `PCHP is a community protocol. It evolves in the open, through a lightweight, legible process modeled on the enhancement-proposal traditions that kept MCP, Python (PEPs), and the IETF (RFCs) coherent as they grew.

## Protocol Enhancement Proposals (PEPs)

Any substantive change to PCHP — a new scope family, a token-profile field, a transport binding, a breaking change — **SHOULD** be written up as a **Protocol Enhancement Proposal**. A PEP is a short document that states:

1. **The human problem.** Whose job does this make easier or safer? Work backwards from them.
2. **The proposal.** The concrete change, in normative language.
3. **Compatibility.** Additive within the current version, or does it require a new dated version?
4. **Security & privacy impact.** What threat does it change? What must an implementer now do?
5. **Reference & conformance.** How will an implementation prove it conforms?

PEPs move through **Draft → Review → Accepted → Final** (or **Withdrawn**). Anyone may open one. Acceptance requires rough consensus and at least one reference implementation for anything that touches the wire.

## Design principles for contributors

When weighing a change, we apply these in order:

1. **Ease of use wins ties.** If two designs are equally correct, the one a newcomer can adopt in an afternoon wins. Adoption is the goal; friction is the enemy.
2. **The owner's control is non-negotiable.** No change may weaken a person's ability to see and revoke access to their own data.
3. **Least privilege by default.** New capabilities ship scoped and time-boxed, never broad and standing.
4. **Honesty over ambition.** Ship what is real; mark proposals as proposals. A legible frontier earns more trust than an impressive-sounding one.
5. **Credit generously.** We name our lineage and our contributors. Credit is not a scarce resource.

## How to participate

- **Read and react.** The fastest contribution is telling us where the spec is unclear. Ease of use is a moving target and adopters are the best signal.
- **Implement.** Build a client, a host, or a validator in your language of choice and match the golden vectors. A second independent implementation is the strongest possible spec review.
- **Propose.** Open a PEP for anything you would change. Start with the human problem.

## Working groups (proposed)

As the community grows, focused working groups keep the surface coherent — for example: Authorization & Scopes, Transparency & Audit Integrity, Financial-Data Profiles (CPA / lender / auditor flows), and Agent Delegation. Charters follow the same PEP shape: name the problem, name the deliverable, name who conforms.

> The measure of this protocol is not how clever it is. It is how many places honor it, and how easily the next person can adopt it. Build for that.`,
  },
  {
    id: "acknowledgements",
    label: "Acknowledgements",
    eyebrow: "Community",
    summary:
      "The lineage PCHP stands on, and our thanks to the people and standards that made it possible.",
    body: `PCHP did not appear from nowhere. Like every good protocol, it is a continuation of work done by people who solved hard problems before us and shared their answers openly. We name them with gratitude — because crediting your lineage is not just good manners, it is how a standard earns trust.

## Direct inspiration

- **The Model Context Protocol (Anthropic).** MCP is the direct structural inspiration for this specification: date-based versioning, capability negotiation in a lifecycle handshake, a schema as the source of truth, an open governance and enhancement-proposal process, and the demonstrated truth that a well-documented, openly-licensed protocol can earn an ecosystem in months. We studied how MCP was built and released, and we have tried to honor its clarity while working backwards from a different human need — a person's consent over their own data.

- **The Language Server Protocol (Microsoft).** MCP itself credits LSP, and so do we. LSP showed the world that an M×N integration nightmare collapses into an M+N solution when you standardize the protocol in the middle. PCHP applies the same move to consent.

## Foundational prior art

- **SSH** — the naming ancestor of *hu_ssh*, "SSH for humans." SSH proved a trust handshake can become invisible, trusted infrastructure. That is the bar for PCHP.
- **OAuth 2.1 and the IETF OAuth working group** — for the authorization primitives (scopes, resource indicators, PKCE, audience binding) PCHP composes with.
- **W3C WebAuthn / FIDO passkeys** — for the owner-approval attestation model.
- **The Kantara Initiative Consent Receipt work and the wider consent/privacy-engineering community** — for taking "consent as a first-class, portable artifact" seriously long before it was fashionable.

## And the commons

Most of all, thank you to the open-source community. PCHP is being **donated back** to that community under the most permissive terms we can (see License). We learned from the best, and the only honest way to repay that is to make it easy for the next team to learn from — and improve on — us.

If we have missed someone whose work we build on, tell us and we will add them. Credit is not a scarce resource.`,
  },
  {
    id: "license",
    label: "License & Donation",
    eyebrow: "Community",
    summary:
      "How PCHP is given to the commons: the most open license we can offer, and why.",
    body: `PCHP is a **gift to the commons**. Our goal is not to own a standard — it is to make consent-first data sharing so easy and so open that it is adopted everywhere, by everyone, faster than any protocol before it. You cannot achieve that behind a restrictive license.

## The license

We dual-dedicate, choosing the most permissive instrument for each artifact:

- **Specification text and diagrams:** dedicated to the public domain via **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. Copy it, fork it, translate it, build a competing implementation, quote it in your own standard — no permission needed, no attribution required (though attribution is always appreciated).
- **JSON Schema, golden vectors, and reference code:** released under **[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)** — permissive, with an explicit patent grant so that adopters are protected.

This is deliberately *more* open than MCP's MIT-only posture. CC0 on the prose removes every possible source of friction for the thing we most want copied: the ideas.

## Why give it away

- **Adoption compounds with openness.** A protocol is worth exactly as much as the number of places it is honored. Restriction caps that number; donation removes the cap.
- **Neutrality requires it.** PCHP can only be trusted as consent infrastructure if no single vendor controls it. Public-domain text is the strongest possible neutrality signal.
- **It is the right thing.** Consent over your own data should not be anyone's proprietary moat. The moat, if there is one, is being the best and most ergonomic *implementation* — not owning the words.

## What we ask in return (nothing required, everything welcome)

- Tell us what breaks and what is unclear — ease of use is a moving target and you are our best signal.
- Contribute enhancement proposals (see Contributing).
- If PCHP helps you, help the next person adopt it. Pay the openness forward.

> We are donating PCHP to the open-source community so that a person's consent over their own data becomes a shared standard, not a product feature. Learn from the best; become better; give it back.`,
  },
];

export const PCHP_SPEC_META = {
  version: PCHP_PROTOCOL_VERSION,
  semver: PCHP_SPEC_SEMVER,
  status: PCHP_STATUS,
  updated: "2026-07-12",
};
