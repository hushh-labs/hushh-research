# Product Agent Development

Use this workflow for runtime product-agent creation or contract changes.

## Goal

Ship one manifest-authored Hussh product agent without authority, prompt,
surface, registry, evaluation, telemetry, or rollback drift.

## Steps

1. Route through `backend`, using `backend-agents-operons` as the default spoke.
2. Extend an existing specialist unless a genuinely new bounded domain is proven.
3. Author the strict `AgentManifestV2` YAML and no parallel manifest or prompt.
4. Keep invocation, data, and action authorities separate and attenuated per hop.
5. Declare every surface applicable or provide a reason it is not applicable.
6. Regenerate the product-agent registry and any affected action/card projections.
7. Run the manifest, hierarchy, surface, evaluation, telemetry, and rollback gates.
8. Hand off trust, voice, native, quality, docs, or deployment work to its owner.

## Common Drift Risks

1. a second top-level router
2. an invocation scope treated as data access
3. copied prompts or Python manifest dictionaries
4. implicit chat, voice, A2A, MCP, web, iOS, or Android applicability
5. missing evaluation, telemetry, kill-switch, rollout, or rollback declarations
