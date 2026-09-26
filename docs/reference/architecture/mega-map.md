# Hussh Mega Map

## Visual Context

Canonical visual owner: [Architecture Index](./README.md). This page is the
human-readable contract for the generated Mega Map SVGs and their regeneration
flow.

> One source-grounded picture of the entire Hussh platform — a layered stack
> (what it is) plus eleven end-to-end user-story flows (how it connects) —
> published as a living SVG. Status colors are honest, not aspirational.

The layer count depends on the audience: the **public** map has seven layers, and
the **internal** map adds the commerce / payments / agent-economy layer for
eight. The layer list on this page is the public seven.

Everything here describes `hussh-mega-map.gen.py`, which is the source of truth.
If this page and the generator disagree, the generator wins.

## What this is

The Mega Map is a single diagram that answers two questions at once:

- **What is the platform?** A clean seven-layer stack, each layer holding its
  real components. Every component states *what* it is, *why* it exists, *how*
  it works, and a concrete *example* — so each claim is debatable, not
  decorative.
- **How does it connect?** Eleven end-to-end flows, one per user story. Each story
  is a single left-to-right sequence of real steps and endpoints. Because every
  story is its own lane, the connections are fully traceable and no two flow
  lines ever cross — connections without spaghetti.

It is deliberately a *map*, not an inventory: you can trace any user journey from
entry surface to encrypted memory and back out through a governed channel.

## Files

All paths are repo root.

| File | Purpose |
| --- | --- |
| `hussh-mega-map.gen.py` | The re-runnable generator and the canonical artifact. Edit the `LAYERS_ALL`, `FLOWS_ALL`, and `GLOSS_ALL` data, re-run, re-publish. |
| `hussh-mega-map.dark.svg` | Internal map, eight layers, dark theme. |
| `hussh-mega-map.light.svg` | Internal map, eight layers, light theme. |
| `hussh-mega-map.dark.public.svg` | Public map, seven layers (commerce layer withheld), dark theme. |
| `hussh-mega-map.light.public.svg` | Public map, seven layers, light theme. |

Regenerate (one run writes all four, next to the generator):

```bash
python3 hussh-mega-map.gen.py
```

## The seven public layers (what it is)

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
   plane, Secret Manager (BYOK refs), auth + push, a parity-gated CI/CD
   pipeline, and the **per-user pod** — one managed container per person
   (`one-pod-<HusshID>`), plus the fleet control plane that provisions,
   heartbeats and reconciles them.

   The pod's shape is the argument for it. It runs under a service account
   holding **no project roles at all**, on `internal` ingress with no
   `allUsers` binding, so the hub is the only thing that can reach it and a
   compromised pod is uninteresting to reach. It holds no database credential
   and no vault key — everything on the data plane travels pod → hub →
   Postgres — and it thinks on the **owner's** AI key supplied per turn, so
   inference cost and quota land on the person whose agent is working rather
   than on a shared pool. Sizing is chosen rather than inherited: 500m CPU,
   1Gi memory, `maxScale=1` for **correctness** (the pod's storage engine
   assumes a single writer), and on the warm tier CPU stays allocated between
   requests so the pod's own heartbeat can actually run.

   Fleet growth is bounded by a real number: Cloud Run allows **1000 services
   per project per region**. That is a sharding trigger, not a wall — the
   operator identity measures consumption and stands up the next project
   before the cap is reached. On Bring-Your-Own-Compute the pod lives in the
   user's own project and the ceiling is theirs, not ours.

## The eleven end-to-end flows (how it connects)

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
11. **Your own private agent** (approved) — choose your AI (managed or your own
    key) → the key is **verified with a real generation** → a Cloud Run service
    `one-pod-<HusshID>` is created with a zero-role service account and internal
    ingress → the pod boots and its first heartbeat reports it is up → the hub
    pulls the pod's public key and mints a standing `pkm.read` grant → a turn
    runs **inside** the pod, on the owner's own key.

    The **order** of that sequence is the architecture, not a drawing choice. A
    pod is earned by a working AI connection and never by a login: provisioning
    on sign-in stands up billable compute behind an event that says nothing
    about whether the agent could ever think. Two further orderings carry the
    same weight — the hub *pulls* the key (a pod's ID token proves "a hussh pod",
    never *which* pod, so a pushed key could be registered against someone
    else's row), and the turn runs on a renewed `pkm.read` grant rather than the
    `vault.owner` master token a browser actually holds.

## Five greenfield gaps

The rose-colored items are the build frontier: ② AI-memory import, ③
public-profile → PKM claim, ④ broker execution, ⑥ CRM / private-cloud proxy,
and ⑨ the on-device edge.

Flow ⑪ is amber rather than green on purpose. The hub serving dev can create a
pod and a pod can run a turn — every flag is live on the serving revision — but
no pod has yet served a turn for a real person, so the map says "approved" and
not "shipped".

## Design discipline

- **Connections without spaghetti** comes from the swimlane discipline: each
  user story is a horizontal lane, so flow lines are explicit and traceable yet
  structurally cannot cross.
- **Symmetry is enforced by math**, not by eye: the content band is centered,
  all layers fill full width to the pixel, all flow lanes share an identical
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
