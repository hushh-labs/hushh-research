# One/Nav Runtime Plan

Status: planning-only roadmap. This is not a current-state implementation contract.

## Visual Map

```mermaid
flowchart TB
  current["Current runtime<br/>Kai-first voice/action plane"]
  one["One layer<br/>default speaker + memory relationship"]
  kai["Kai specialist<br/>finance actions"]
  nav["Nav specialist<br/>privacy + consent actions"]
  gates["Promotion gates<br/>contracts, tests, copy, rollout"]

  current --> one
  one --> kai
  one --> nav
  one --> gates
```

## Current Overlap

The current app already has pieces the One/Nav model can reuse:

- a generated voice/action gateway from local `.voice-action-contract.json` files
- route, persona, vault, auth, consent, and onboarding guards
- encrypted, vault-gated durable voice memory
- consent center, profile security, deletion, and scoped-access surfaces
- Kai finance routes, analysis actions, search grounding, and command execution

The gap is not capability existence. The gap is ownership clarity: the live runtime still defaults to Kai as the assistant identity in many places, while the product direction makes One the top relationship layer and Nav the privacy guardian.

## Missing Primitives

Before One/Nav becomes current-state runtime, the repo needs these primitives:

1. `speaker_persona` carried from local action contracts through the generated gateway, manifest, frontend registry, backend prompt selection, and composer path.
2. Prompt identity templates for `one`, `kai`, and `nav`.
3. TTS instruction selection for the active speaker persona.
4. Shell copy ownership rules for greetings, notifications, memory, consent, and specialist handoffs.
5. Nav-owned action inventory for consent, vault, deletion, revocation, and scope review.
6. Analytics/event fields that distinguish workspace persona from speaking agent.
7. Verification that `nav.*` means Nav guardian capability, while `route.*` means navigation.

## Promotion Criteria

Move this plan into execution docs only when:

- every generated action has a valid `speaker_persona`
- `rg "nav\\." contracts/kai hushh-webapp consent-protocol docs .codex` finds only true Nav guardian actions or roadmap prose
- voice planner/composer prompts can select One, Kai, or Nav without weakening existing English-only, vault, consent, or rollout controls
- shell and design-system docs define which copy surfaces belong to One, Kai, and Nav
- tests cover route actions, finance actions, and privacy/consent actions with the correct speaker persona
- UAT can prove that finance workflows still execute through Kai while consent/privacy workflows are framed by Nav

## Phases

### Phase 1: Contract Hygiene

- Rename navigation action ids from `nav.*` to `route.*`.
- Add `speaker_persona` to local contracts and generated outputs.
- Reserve `nav.*` for true Nav guardian actions.
- Update docs, skills, tests, and audits in the same change.

### Phase 2: Prompt And Speech Selection

- Add One/Kai/Nav prompt identity templates.
- Route planner/composer speech through `speaker_persona`.
- Keep English-only STT/planner/composer/TTS constraints unchanged.
- Do not change trust or execution authority based on speaker persona.

### Phase 3: Shell And Copy Migration

- Move greetings, notifications, memory recall, and generic help toward One.
- Move consent review, scope review, deletion, revocation, vault, and suspicious-access copy toward Nav.
- Keep finance analysis, market, portfolio, and RIA finance decisions with Kai.

### Phase 4: Nav Capability Inventory

- Add explicit Nav actions for consent and privacy work.
- Keep route actions as `route.*`.
- Add tests proving Nav actions are not just renamed navigation actions.

### Phase 5: UAT Promotion

- Run focused voice, docs, typecheck, and backend voice suites.
- Run UAT smoke for finance, consent, vault, deletion, and notification flows.
- Promote only after current-state docs can describe One/Nav without future-state caveats.

## Risks

| Risk | Mitigation |
| --- | --- |
| Kai identity bleeds into generic assistant copy | Design-system copy ownership rules and voice prompt speaker selection |
| Nav becomes a branding label for navigation | Reserve `nav.*` for privacy/consent guardian actions; use `route.*` for navigation |
| One/Nav copy overclaims shipped runtime | Docs governance requires current-state versus future-state wording |
| Personality work weakens trust controls | Speaker persona never changes guards, tokens, vault policy, or consent enforcement |
| Duplicate action paths appear during migration | Straight rename only; no legacy alias, no dual-write, no compatibility acceptance path |

## Verification Gates

Contract hygiene:

```bash
cd hushh-webapp && npm run build:voice-gateway
cd hushh-webapp && npm run verify:voice-gateway
rg "nav\\." contracts/kai hushh-webapp consent-protocol docs .codex
```

Runtime proof:

```bash
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run test -- __tests__/voice/kai-action-gateway.test.ts __tests__/voice/voice-action-manifest.test.ts __tests__/voice/investor-kai-action-registry.test.ts __tests__/voice/voice-grounding.test.ts __tests__/voice/voice-turn-orchestrator.test.ts
cd consent-protocol && python3 -m pytest tests/test_kai_voice_contract.py tests/test_kai_voice_rollout_guardrails.py -q
```

Docs and skills:

```bash
./bin/hushh docs verify
python3 .codex/skills/docs-governance/scripts/doc_inventory.py tier-a
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
./bin/hushh codex audit
```

## Out Of Scope

- No production claim that One/Nav is fully shipped before the runtime proves it.
- No callable alias path for previous route-navigation `nav.*` action ids.
- No celebrity voice references in canonical docs.
- No personal numeric preference in canonical docs.
