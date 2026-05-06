# Truth-First Operating Kernel

This is the shared contract for repo-local Codex skills, workflows, and custom agents.

The goal is simple: derive facts from the repo before accepting the prompt. A user, contributor, PR title, issue description, or prior memory can be directionally useful, but it is not repo truth.

## Operating Loop

1. Extract material claims from the request before answering or acting.
2. Verify each material claim against current repo evidence.
3. Classify each claim with the canonical labels below.
4. Answer, review, plan, or patch from the classification, not from conversational agreement.
5. Prefer extending the existing canonical contract over proposing a parallel implementation.
6. If a host cannot spawn a relevant evidence lane, record that availability gap and perform the evidence pass locally.

## Claim Classifications

Use these exact labels in agent handoffs, review notes, and workflow artifacts when a material claim affects direction:

1. `already_exists`
2. `partially_exists`
3. `missing`
4. `future_state_only`
5. `wrong_direction`
6. `needs_verification`

If a capability exists transiently but not durably, classify it as `partially_exists` and name the real gap: persistence, schema, generated contract, tests, docs, UI visibility, observability, consent, vault, cache, deployment parity, or operational proof.

## Evidence Order

Prefer evidence in this order:

1. Current executable code and generated contracts.
2. Checked schema contracts, migrations, release manifests, and route/action manifests.
3. Tests that prove the current contract.
4. Runtime logs, CI, deployment, and environment signals when relevant.
5. Durable docs that explicitly distinguish current state from future state.
6. Founder drafts, PR descriptions, issue text, and chat prompts only as claims to verify.

When sources disagree, current executable code plus checked contracts beat prose. Create a docs follow-up when durable docs drift from runtime truth.

## Default Answer Shape

For repo-backed Q&A and contributor guidance, answer in this order:

1. Exact correction or current truth.
2. Direct answer to the asked question.
3. Where the work belongs.
4. What not to build.
5. Smallest acceptable next PR.

Do not write as if the project is blank. Hussh already has shipped contracts, and Codex must actively find and reuse them.

## Agent Evidence Handoff

Every read-only evidence lane should return:

1. `claim_inspected`
2. `classification`
3. `evidence_checked`
4. `current_repo_truth`
5. `real_gap`
6. `suggested_boundary`
7. `risk_if_prompt_is_accepted_blindly`
8. `scope_covered`
9. `inspected_surfaces`
10. `assumptions`
11. `validations_run`
12. `unresolved_risks`

Do not ask or answer only `looks good`, `safe`, `aligned`, or `green`. Those are conclusions, not evidence.

## Domain Fact Probes

These probes define where to look before answering high-risk claims. They are not hardcoded answers.

### Kai Decisions

Check the realtime quote path, stream decision payload, Decision Card shape, raw card/analysis history, market snapshot fields, diagnostics, outcome telemetry, and weight profile boundary before accepting claims about missing price, missing context, or adaptive weights.

Default boundary:

- realtime quote and market context may already exist in the analysis path
- the likely durable gap is evaluation persistence, not the visible Decision Card
- weights do not belong in a user-facing logging card
- do not mutate weights live from noisy portfolio outcomes; use shadow logging, offline cohort evaluation, and promotion gates first

### MCP And Consent Tools

Check dynamic scopes, `discover_user_domains`, `/api/v1/user-scopes/{user_id}`, developer tool entitlement, and per-call consent validation before accepting claims that tool lists or scopes are static.

Default boundary:

- tool visibility is not the security boundary
- server-side entitlement, token validation, and consent validation still own authorization
- do not build a parallel dynamic-tool system when an existing scope or entitlement contract should be hardened

### PKM And Vault

Check encrypted source of truth, manifest authority, cloud projection, local-first cache, vault owner token flow, and PKM versus telemetry boundaries before accepting storage or memory proposals.

Default boundary:

- projections can be readable or sync-oriented, but canonical memory must remain governed by vault/PKM authority
- markdown or LLM-wiki outputs are projections unless explicitly promoted through consent, schema, and sync contracts

### Voice And Action Gateway

Check generated voice/action contracts, existing realtime voice path, action IDs, `speaker_persona`, planner/executor flow, typed-search parity, route metadata, and vault/session gates before accepting a new mic, dictation, transcript, or action surface.

Default boundary:

- do not create duplicate voice surfaces
- new UI must integrate with the canonical generated action gateway and shared state model

### PR Governance

Check current canonical surface, exact and semantic duplicates, route reachability, schema/migration parity, generated contracts, live report state, CI freshness, and north-star alignment before treating green CI as merge readiness.

Default boundary:

- green CI is intake only
- duplicate, schema, trust-boundary, and runtime reachability findings override green gates

### Frontend

Check actual reachable UI paths, app shell ownership, design-system owner, Next navigation continuity, route guards, vault/session continuity, and mobile/native parity before judging UI work as shipped value.

Default boundary:

- unused components are not product improvements
- direct route jumps are not the same as sequential UI navigation when vault/session state matters

### Data Model

Check schema contracts, migrations, release manifest, UAT migration readiness, rollback/repair behavior, cache coherence, and local-first/cloud projection authority before accepting DB or sync claims.

Default boundary:

- merge readiness and UAT apply readiness are separate
- cloud metadata is not the source of encrypted user memory truth unless the architecture explicitly says so

## Community Q&A Contract

Community replies must be founder-direct and concise:

1. Default outputs are `Brief reply` and `Detailed reply`.
2. Add `Firmer reply` only when explicitly requested or when a separate correction is materially useful.
3. Correct wrong premises first.
4. Do not "yes-and" a contributor proposal before checking whether the capability already exists.
5. Prefer one crisp correction plus one concrete next PR boundary over broad agreement.

Recurring fixtures:

1. `price is missing` -> classify as `partially_exists`; quote/market context exists or must be checked first, while durable evaluation persistence may be missing.
2. `make MCP tools dynamic by consent` -> classify existing dynamic scopes and entitlement before proposing hardening.
3. `add voice mic` -> inspect existing realtime voice and action gateway before accepting a duplicate surface.
4. `store LLM wiki as markdown` -> distinguish markdown projection from canonical PKM.
5. `green CI means merge` -> require north-star, duplicate, schema, runtime, and trust-boundary checks.
