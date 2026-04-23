# Kai Voice Governance

Use this workflow pack when the task matches `kai-voice-governance`.

## Goal

Keep Kai voice, typed search, UI actionables, persona/workspace gating, and durable memory boundaries aligned through one generated action gateway.

## Steps

1. Start with `kai-voice-governance`.
2. Read the gateway contract doc, runtime architecture doc, and review checklist before editing behavior.
3. Author capability existence in local `.voice-action-contract.json` files, not in runtime heuristics.
4. Rebuild the gateway and compatibility manifest after any contract change.
5. Keep search, voice, and control-id mappings on the same `action_id`.
6. Treat persona, vault, consent, onboarding, and workspace state as central guard inputs.
7. Use authored multi-step workflows only when the UI really supports the same prerequisite chain.
8. Keep durable voice memory vault-gated and encrypted client-side.
9. Run the gateway verifier, targeted voice tests, backend voice contract test, and docs verification.
10. Hand off to `frontend`, `backend-api-contracts`, `vault-pkm-governance`, `docs-governance`, or `quality-contracts` when the task becomes primarily theirs.

## Common Drift Risks

1. adding discoverable behavior without a local contract
2. duplicating action identity across search, voice, and tap
3. encoding persona or unlock logic in prompt text instead of gateway guards
4. guessing workflow prerequisites from transcript heuristics
5. allowing durable memory to bypass vault unlock or encryption
6. updating runtime code without regenerating artifacts and docs
