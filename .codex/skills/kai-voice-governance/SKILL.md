---
name: kai-voice-governance
description: Use when changing Kai voice capability authoring, generated action gateway contracts, typed-search and voice parity, persona/workspace gating, or BYOK-safe durable voice memory.
---

# Kai Voice Governance Skill

## Purpose and Trigger

- Primary scope: `kai-voice-governance`
- Trigger on Kai voice capability authoring, generated gateway changes, typed-search and voice parity work, action workflow chaining, persona/workspace gating, or durable voice memory boundary changes.
- Use this skill when the request is about how Kai recognizes, filters, executes, or explains actions across voice and search.
- Avoid overlap with `frontend` for generic UI work, `backend-api-contracts` for route-only contract changes, and `vault-pkm-governance` for broad vault policy work that is not specific to Kai voice.

## Coverage and Ownership

- Role: `owner`
- Owner family: `kai-voice-governance`

Owned repo surfaces:

1. `contracts/kai`
2. `consent-protocol/hushh_mcp/services/voice_action_manifest.py`
3. `docs/reference/kai`
4. `hushh-webapp/lib/voice`
5. `hushh-webapp/scripts/voice`
6. `hushh-webapp/components/kai`
7. `hushh-webapp/components/consent`
8. `hushh-webapp/app/kai`
9. `hushh-webapp/app/profile`
10. `hushh-webapp/app/ria`
11. `.codex/skills/kai-voice-governance`

Non-owned surfaces:

1. `frontend`
2. `backend-api-contracts`
3. `vault-pkm-governance`
4. `docs-governance`
5. `quality-contracts`

## Do Use

1. Adding or changing local `.voice-action-contract.json` files.
2. Changing the generated Kai action gateway or compatibility manifest.
3. Mapping typed search, voice, and tappable UI actionables to the same `action_id`.
4. Authoring or reviewing multi-step workflows that chain persona switches, route transitions, or tool calls.
5. Tightening persona, vault, consent, onboarding, and workspace guard handling.
6. Enforcing BYOK/ZK-safe durable voice memory behavior.

## Do Not Use

1. Generic frontend layout or shell work with no voice/search/actionability impact.
2. Broad backend runtime work unrelated to Kai voice contracts.
3. Generic docs cleanup without Kai voice ownership implications.
4. Security intake where the primary question is IAM or consent policy rather than Kai voice behavior.

## Read First

1. `docs/reference/kai/kai-action-gateway-vnext.md`
2. `docs/reference/kai/kai-voice-runtime-architecture.md`
3. `.codex/skills/kai-voice-governance/references/voice-review-checklist.md`

## Workflow

1. Treat local `.voice-action-contract.json` files as the authoring source of truth.
2. Keep the generated gateway as the shared semantic authority and the manifest as a compatibility artifact.
3. Do not add capabilities through runtime heuristics or ad hoc DOM discovery.
4. Reuse one stable `action_id` across voice, search, UI actionables, analytics, and docs.
5. Author multi-step workflows only when the UI can actually move through the same prerequisite chain.
6. Require settlement between workflow steps; do not assume route push success equals completion.
7. Treat persona and workspace as hard preconditions:
   - ask before switching persona when the target workspace is earned
   - block and guide when the capability is not unlocked
8. Keep runtime surface metadata focused on current state, not capability existence.
9. Keep short-term voice memory in-memory only.
10. Keep durable voice memory vault-gated, client-side encrypted, and out of plaintext browser storage.
11. Prefer non-blocking governance for missing contracts:
   - missing contract means not discoverable
   - surface the gap in review and docs
12. Update docs and tests in the same change when capability semantics shift.
13. During review, require:
    - local contracts for new discoverable capabilities
    - `speaker_persona` on every action with allowed values `one`, `kai`, `nav`, or `kyc`
    - `delegate_agent_id` on actions executed by a specialist on behalf of One, with allowed values `one`, `kai`, `nav`, or `kyc`
    - stable `control_ids` for mapped UI actionables
    - shared `action_id` parity across search and voice
    - `route.*` for ordinary navigation and `nav.*` only for Nav privacy/consent guardian actions
    - central persona, vault, consent, and onboarding gating
    - no durable-memory regression to plaintext or unlocked-free reads
14. Speaker persona is prompt/copy ownership only:
    - One owns route, shell, memory, generic, and handoff framing.
    - Kai owns finance, analysis, portfolio, market, and RIA finance actions.
    - Nav owns privacy, consent, vault, deletion, revocation, and scope-review actions.
    - KYC owns explicit identity/KYC workflow status, missing-document review, approval-gated drafts, and structured PKM writeback.
    It must never grant authority or bypass auth, vault, consent, persona, workspace, rollout, or kill-switch gates.
15. Do not add legacy aliases for old navigation `nav.*` ids. Navigation namespace migrations are straight renames unless the user explicitly approves a compatibility program.

## Handoff Rules

1. Route generic UI structure questions to `frontend`.
2. Route route/request/response contract work to `backend-api-contracts`.
3. Route vault and encrypted-storage boundary work to `vault-pkm-governance`.
4. Route generic documentation-home decisions to `docs-governance`.
5. Route large verification-policy changes to `quality-contracts`.

## Required Checks

```bash
cd hushh-webapp && npm run build:voice-gateway
cd hushh-webapp && npm run verify:voice-gateway
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run test -- __tests__/voice/kai-action-gateway.test.ts __tests__/voice/voice-action-manifest.test.ts __tests__/voice/investor-kai-action-registry.test.ts __tests__/voice/voice-grounding.test.ts __tests__/voice/voice-turn-orchestrator.test.ts
cd consent-protocol && python3 -m pytest tests/test_kai_voice_contract.py -q
./bin/hushh docs verify
```
