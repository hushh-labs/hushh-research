# PR Governance Blocker Gates

Use this reference when a PR touches a high-risk runtime family or when a green PR still feels directionally questionable.

## Universal Blockers

Block or patch before merge when a PR:

1. Adds a parallel runtime for an existing capability.
2. Changes auth, consent, vault, PKM, voice, finance, route, generated contract, or public ingress behavior without canonical caller/contract proof.
3. Adds a standalone agent/service/reducer/export/ingestion path that is not reachable from the current app/runtime.
4. Ships tests that cannot fail, duplicate production logic, or prove only mocks while claiming contract coverage.
5. Introduces broad dependencies or platform changes without install/build/runtime smoke tied to the changed surface.
6. Has CI Status Gate green but another current check introduced by the PR is failing.

## Domain Gates

### Auth / Consent / IAM

Require DB-backed enforcement for critical token semantics. UI visibility is not security. Consent/audit history on authenticated routes must come from canonical consent-center/history APIs, not hardcoded grants or demo records.

### PKM / Vault / Memory

Encrypted domain data, manifests, mutation events, and local cache write-through remain authoritative. Cloud `pkm_index` and projection tables are discovery/sync metadata only. Block plaintext persistence, vault bypass, or local/offline failure caused by missing cloud projection.

### Voice / Action Gateway

Voice and typed search must route through generated contracts, current voice manifest, orchestrator, dispatcher, and backend intent service. Browser SpeechRecognition, dictation, or a second mic surface is a product-surface duplicate unless explicitly approved as an accessibility fallback and wired to the same vault/availability/copy boundaries.

### Kai Finance / Market Analysis

Block direct buy/sell instructions, return promises, or personalized trading-action copy unless a separate regulated-advice contract exists. Extra LLM calls, mediators, retries, or consensus paths require latency, rate-limit, timeout, fallback, and unchanged caller-semantics proof.

### Frontend / Route Shell

A changed component must be reachable from a current route, shell, service caller, or live component before it can be described as a user-visible improvement. Browser route tests that claim continuity must use sequential UI navigation and same-session probes, not only direct `page.goto(...)`.

### Backend / API / Proxy

Backend route or payload changes require matching caller, proxy, docs, or test proof. Route placement and runtime ownership must match the repo-derived backend contract surface.

### Migrations / Schema

Merge only when SQL migration, release manifest, checked-in schema contract, and local release-contract verification move together. UAT-ready claims require live schema verification and a migration apply plan for missing live objects.

### Founder / Ontology Copy

Preserve Hussh as platform, One as personal agent, Kai as finance specialist, and Nav as privacy/consent guardian. Do not ship future-state claims as current runtime truth.

## Duplicate Decision Rules

1. Same head SHA: exact duplicate.
2. Same product/runtime outcome after manual diff review: semantic duplicate.
3. Same files but different behavior: shared-file sequence, not duplicate.
4. For UI duplicates, choose canonical by scope containment, design-system fit, accessibility, layout safety, contract preservation, and type/test readiness. Diff size breaks ties only.
