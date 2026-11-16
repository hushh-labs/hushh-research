---
name: model-provider-governance
description: Use when upgrading, adding, or cutover-verifying AI models or runtime providers across Gemini/Vertex, Azure OpenAI, BYOK, or managed text/search/voice transports.
---

# Hussh Model and Provider Governance Skill

## Purpose and Trigger

- Primary scope: `model-provider-governance`
- Trigger on AI model generation upgrades, new runtime provider onboarding, thinking/sampling compatibility adapters, grounded search/sub-agent latency calibration, or home-project provider readiness probes.
- Avoid overlap with `backend-agents-operons`, `repo-operations`, and `security-audit`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `backend`

Owned repo surfaces:

1. `consent-protocol/hushh_mcp/runtime_providers`
2. `consent-protocol/hushh_mcp/managed_ai_config.py`
3. `consent-protocol/scripts/verify_managed_vertex_runtime.py`
4. `consent-protocol/scripts/probe_gemini_generation_contract.py`

Non-owned surfaces:

1. `backend`
2. `backend-agents-operons`
3. `repo-operations`
4. `security-audit`

## Do Use

1. Upgrading fleet text, live-voice, or embedding model generations across Vertex AI, Azure OpenAI, BYOK, or on-device adapters.
2. Auditing `thinking_level` floors, sampling compatibility, and sub-agent/grounded-tool latency across `dev`, `uat`, and `production`.
3. Maintaining provider readiness probes, capability checks, and model catalog/preference parity.

## Do Not Use

1. Broad backend intake where the owning spoke is not yet clear.
2. Agent hierarchy, tool-boundary, or operon business logic unrelated to model/provider behavior.
3. Cloud Run deployment execution, Org Policy mutations, or Admin SOP merges without routing through `repo-operations`.

## Read First

1. `.agents/skills/model-provider-governance/references/provider-upgrade-checklist.md`
2. `.agents/skills/repo-operations/references/managed-provider-readiness.md`
3. `consent-protocol/docs/reference/agent-development.md`
4. `docs/architecture/ai/README.md`

## Workflow

1. Verify cloud prerequisites first: Org Policy `vertexai.allowedModels` (`:predict` allowlist + propagation), native home-project IAM (`roles/aiplatform.user` on API and worker), GA launch stage, and capacity tiering (Dedicated GSUs on Prod vs Uncapped DSQ on UAT/Dev).
2. Probe the target model live (`probe_gemini_generation_contract.py`) to verify supported `thinking_level` floors (e.g. `MINIMAL -> LOW` normalization) and strip unsupported sampling fields in `gemini_config.py`.
3. Audit the full agent tree (`agents/*/agent.yaml` + Python builders in `one_adk/`) so root, `one_intro`, and grounded `AgentTool` children (`google_search`) explicitly enforce `thinking_level` across `dev` and `production`, not only UAT's `ManagedPrimaryTextModel`.
4. Pair investigative sub-agent prompts (`google_search`) with a tiered fast-path rule for direct factual lookups and prove latency, `thoughtsTokenCount`, and query counts via live A/B benchmarks.
5. Update model defaults, `model_catalog.py`, and preference tests together so live chat never self-reports a retired model, and keep touched modules within architecture-fitness line budgets.
6. Regenerate `product-agent-registry.v2.json` and check capability matrices whenever `agent.yaml` manifests change.
7. Hand off branch sync, 3-stage Production worker/connection-budget rollout, and live post-cutover verification across Dev, UAT, and Prod to `repo-operations` and `verify-before-claim`.

## Handoff Rules

1. Route broad or ambiguous backend requests back to `backend`.
2. Route ADK specialist/tool orchestration contracts to `backend-agents-operons`.
3. Route CI, branch parity, Org Policy/quota operations, and cloud deployments to `repo-operations`.
4. Route BYOK key custody, consent scopes, and vault boundaries to `security-audit`.

## Required Checks

```bash
cd consent-protocol && uv run python scripts/generate_product_agent_registry.py --check
cd consent-protocol && uv run python scripts/generate_pod_specialist_capability_matrix.py --check
cd consent-protocol && uv run pytest tests/services/test_one_vertex_search_contract.py tests/services/test_one_search_answer_contract.py tests/test_model_preference_resolution.py -q
cd consent-protocol && uv run pytest tests/test_vertex_capability_probe.py tests/test_managed_vertex_readiness_script.py -q
```
