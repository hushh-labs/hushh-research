---
name: kai-voice-governance
description: Use when changing Kai voice capability authoring, generated action gateway contracts, typed-search and voice parity, persona/workspace gating, or BYOK-safe durable voice memory.
---

# Kai Voice Governance Skill

## Purpose and Trigger

- Primary scope: `kai-voice-governance`
- Trigger on Kai voice capability authoring, generated gateway changes, typed-search and voice parity, action workflow chaining, persona/workspace gating, or durable voice memory boundary changes.
- Avoid overlap with `frontend`, `backend-api-contracts`, and `vault-pkm-governance`.

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

1. Local `.voice-action-contract.json`, generated gateway, or manifest changes.
2. Voice/search/UI action parity around stable `action_id`.
3. Persona, workspace, vault, consent, onboarding, and durable voice memory gates.

## Do Not Use

1. Generic frontend layout or backend route work without voice/search/action impact.
2. Generic docs cleanup without Kai voice ownership implications.
3. Security intake where IAM or consent policy is primary.

## Read First

1. `docs/reference/kai/kai-action-gateway-vnext.md`
2. `docs/reference/kai/kai-voice-runtime-architecture.md`
3. `.codex/skills/kai-voice-governance/references/voice-review-checklist.md`

## Workflow

1. Treat local voice action contracts as the authoring source of truth.
2. Keep the generated gateway as semantic authority and the manifest as compatibility artifact.
3. Reuse stable `action_id` values across voice, search, UI actionables, analytics, and docs.
4. Do not add capabilities through runtime heuristics, ad hoc DOM discovery, or parallel voice systems.
5. Author workflows only when the UI can move through the same prerequisite chain with settlement between steps.
6. Treat persona, workspace, vault, consent, onboarding, rollout, and kill-switch gates as hard preconditions.
7. Keep short-term memory in-memory only and durable memory vault-gated, client-side encrypted, and out of plaintext storage.
8. Block new microphone, dictation, transcript, or voice-like inputs unless they are approved adapters over the existing gateway path.
9. Use `voice-review-checklist.md` before recommending or merging voice-adjacent PRs.

## Handoff Rules

1. Generic UI structure routes to `frontend`.
2. Route/request/response contracts route to `backend-api-contracts`.
3. Vault and encrypted-storage boundaries route to `vault-pkm-governance`.
4. Documentation-home decisions route to `docs-governance`.
5. Verification-policy changes route to `quality-contracts`.

## Required Checks

```bash
cd hushh-webapp && npm run build:voice-gateway
cd hushh-webapp && npm run verify:voice-gateway
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run test -- __tests__/voice/kai-action-gateway.test.ts __tests__/voice/voice-action-manifest.test.ts __tests__/voice/investor-kai-action-registry.test.ts __tests__/voice/voice-grounding.test.ts __tests__/voice/voice-turn-orchestrator.test.ts
cd consent-protocol && python3 -m pytest tests/test_kai_voice_contract.py -q
./bin/hushh docs verify
```
