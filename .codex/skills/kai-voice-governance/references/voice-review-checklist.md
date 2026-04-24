# Kai Voice Review Checklist

Use this when reviewing Kai voice or typed-search changes.

## Capability Authoring

- Does each new discoverable capability have a local `.voice-action-contract.json` entry?
- Is the `action_id` stable and reused across voice, search, and UI actionables?
- Are `control_ids` present for UI affordances that should map back to the action?

## Workflow And Gating

- If the action needs prerequisites, is the workflow explicitly authored?
- Does each workflow step have a clear settlement target or an intentional reason not to?
- Are persona, workspace, vault, auth, consent, and onboarding constraints modeled centrally?
- Does an earned-but-inactive workspace require ask-before-switch?
- Does a locked capability block and guide instead of pretending to execute?

## Runtime Boundary

- Does runtime surface metadata describe current state rather than invent capabilities?
- Does the generated gateway remain the shared semantic authority?
- Is transcript fallback still only a compatibility path rather than the primary discoverability mechanism?

## Memory Boundary

- Is short-term memory still in-memory only?
- Is durable voice memory vault-gated?
- Is durable storage encrypted client-side?
- Is plaintext browser storage avoided?
- Are sensitive summaries rejected?

## Verification

- `npm run build:voice-gateway`
- `npm run verify:voice-gateway`
- targeted voice tests
- backend voice contract test when shared semantics changed
