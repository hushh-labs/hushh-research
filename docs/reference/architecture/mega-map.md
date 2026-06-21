# Hussh Mega Map

## Visual Context

Canonical visual owner: [Architecture Index](./README.md). This page is the
human-readable contract for the generated `hussh-mega-map.svg` artifact and its
regeneration flow.

> One source-grounded picture of the entire Hussh platform — seven layers (what
> it is) plus ten end-to-end user-story flows (how it connects) — published as a
> living SVG. Status colors are honest, not aspirational.

**Status as of 2026-06-10.**

## What this is

The Mega Map is a single diagram that answers two questions at once:

- **What is the platform?** A clean seven-layer stack, each layer holding its
  real components. Every component states *what* it is, *why* it exists, *how*
  it works, and a concrete *example* — so each claim is debatable, not
  decorative.
- **How does it connect?** Ten end-to-end flows, one per user story. Each story
  is a single left-to-right sequence of real steps and endpoints. Because every
  story is its own lane, the connections are fully traceable and no two flow
  lines ever cross — connections without spaghetti.

It is deliberately a *map*, not an inventory: you can trace any user journey from
entry surface to encrypted memory and back out through a governed channel.

## Files

| File | Purpose |
| --- | --- |
| `hussh-mega-map.gen.py` (repo root) | The re-runnable generator. Edit the `LAYERS` and `FLOWS` data, re-run, re-publish. |
| `hussh-mega-map.svg` (repo root) | Rendered vector output. Zoom-crisp at any scale; this is the canonical artifact. |

Regenerate:

```bash
python3 hussh-mega-map.gen.py        # writes hussh-mega-map.svg
```

## The seven layers (what it is)

1. **Experience · Interaction** — where a person or an AI meets Hussh: Web
   (Next.js shared React shell), iOS/Android (Capacitor native, secure enclave),
   Mac (on-device runtime), and external MCP hosts. Transport is tri-flow:
   web proxy, native plugin, or MCP — same product truth on every surface.
2. **Channels · Ecosystem** — governed ways results and capabilities reach
   users, developers, and partners: the Developer API (`/api/v1` discover →
   consent → export), the hosted MCP (`@hushh/mcp`, six consent tools), the
   Marketplace (RIA ↔ investor strategy sharing under a relationship grant),
   agent Certification tiers (Sandbox → Verified → Trusted), and Partner CRM
   sync over a private-cloud proxy with narrow approved fields only — never a
   PKM mirror.
3. **Intelligence · Agents** — reason, debate, delegate, and act inside scoped
   authority, never with raw keys: the orchestrator (One), the privacy/consent
   guardian (Nav), the finance specialist (Kai), AlphaAgents → broker execution
   (a three-agent debate producing a DecisionCard, with execution as future
   state), and the Hussh SDK (know · do · remember) so anyone can build under
   the same contract.
4. **Data · Knowledge · PKM** — the heart: one encrypted store the user truly
   owns, zero-knowledge. Encrypted `pkm_blobs` (ciphertext-only per domain),
   manifests and a scope registry, the 24-domain schema across six families
   (Being · Knowing · Relating · Having · Wanting · Acting), a safe `pkm_index`
   discovery projection, and freshness-aware market/provider caches.
5. **Trust · Identity · Consent · PCHP** — the gate every action passes through:
   identity bootstrap, biometric vault unlock with BYOK (the key lives only in
   memory), Capability Tokens (`VAULT_OWNER` 24h, scoped 7d), the PCHP six-phase
   handshake (Discover → Hello → Offer → Consent → Deliver → Ack), and ZK scoped
   export with a tamper-evident audit log (AES-GCM payload, X25519-wrapped key,
   CRT/DAT).
6. **Core Platform Services** — the backend that enforces policy and brings
   chosen data in: the Consent Protocol routes (consent · PKM · IAM · Kai ·
   RIA), the AI-memory import connector, the Gmail connector (receipts → brand
   signals), the Plaid connector (read-only holdings), and the RIA Intelligence
   API (Stage 1 regulatory verify → Phase 2 dossier → image discover + rank).
7. **Infrastructure** — the governed foundation: Cloud Run, Postgres data
   plane, Secret Manager (BYOK refs), auth + push, and a parity-gated CI/CD
   pipeline.

## The ten end-to-end flows (how it connects)

Each flow is one left-to-right sequence on the map. The status reflects current
reality.

1. **Build PKM** (shipped) — Sign in → mint `VAULT_OWNER` (24h) → unlock vault
   (BYOK biometric) → client encrypts a domain → `POST /api/pkm/store-domain` →
   `pkm_blobs` ciphertext + index.
2. **Import AI memory** (future) — OAuth the AI provider → download the memory
   export → parse and map to the 24 domains → client encrypts → store into
   mind · knowledge · preferences.
3. **Claim public profile** (approved) — seed name · email · phone → Stage 1
   regulatory verify (FINRA/SEC) → Phase 2 dossier from the public web → image
   discover + rank → user selectively claims → store to PKM.
4. **AlphaAgents → trade** (approved) — ask Kai (`/api/kai/analyze`) →
   three-agent debate (fundamental · sentiment · valuation) → Renaissance
   overlay tiers → DecisionCard (Buy/Hold/Reduce) → store decision under
   financial → future broker order.
5. **Build Hussh agents** (approved) — SDK (know · do · remember) → register and
   certify (tiers) → publish to the marketplace → runs under the One / Nav
   contract → requests data via `/api/v1`.
6. **Partner CRM via private-cloud proxy** (future) — partner CRM request →
   consent for narrow fields only → private-cloud proxy → CRM updated (never a
   PKM mirror) → consent receipt logged.
7. **Consent via MCP · PCHP** (shipped) — relying service Discovery
   (`.well-known/hussh`) → Hello (UA capabilities) → Offer (scopes · purpose ·
   TTL) → Consent (biometric → CRT) → ZK export (AES-GCM + X25519) → Ack to the
   Transparency Log.
8. **Native + Web parity** (shipped) — user triggers an action → generated
   action plane → web Next.js proxy or native Capacitor plugin → Consent
   Protocol API → same truth on any surface.
9. **On-device edge** (future) — Mac runs the on-device runtime → local file
   index → on-device inference → dev tools (cloud · source · CLI · MCP) → acts
   under the same consent.
10. **RIA shares strategies** (approved) — advisor builds picks → marketplace
    relationship grant → `ria_active_picks_feed_v1` → chosen investor contacts →
    investor market home.

## Five greenfield gaps

The rose-colored items are the build frontier: ② AI-memory import, ③
public-profile → PKM claim, ④ broker execution, ⑥ CRM / private-cloud proxy,
and ⑨ the on-device edge.

## Design discipline

- **Connections without spaghetti** comes from the swimlane discipline: each
  user story is a horizontal lane, so flow lines are explicit and traceable yet
  structurally cannot cross.
- **Symmetry is enforced by math**, not by eye: the content band is centered,
  all layers fill full width to the pixel, all ten flow lanes share an identical
  step-span, and every handoff chevron sits at the exact vertical center of its
  inter-layer gap (verified Δ = 0.00px).
- **The map is a living artifact** — regenerate it as the platform evolves and
  re-publish the SVG.

## Where it is published

The map is published on the Hussh wiki as a rich article with the SVG embedded
and rendered natively (zoom-crisp), grounded in the canonical sources below.

## Sources

This map is grounded in, and should stay consistent with:

- [`architecture.md`](./architecture.md) — the canonical seven-layer model and
  runtime sequence diagrams.
- [`api-contracts.md`](./api-contracts.md) — the endpoint and token contracts
  used in the flows.
- `hussh-dev-platform` — Hussh Protocol Specification v1.1 (PCHP six-phase
  handshake, 24-domain schema, CRT/DAT).
- `hushh-ria-intelligence-api` — `PROJECT_MAP.md` (Stage 1 verify → dossier →
  image rank).
