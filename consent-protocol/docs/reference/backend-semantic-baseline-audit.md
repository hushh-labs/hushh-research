# Backend Semantic Baseline Audit


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This revision-bound audit classifies backend semantic surfaces against the agent-only PKM
methodology as inspected on 2026-09-23. It does not establish deployed model behavior.

Status values:

- `canonical`
- `deterministic_support`
- `drift_or_legacy`
- `mixed_transitional`

## Baseline matrix

| Surface | Owner | Current classification path | Agent-only compliant | Deterministic by design | Status | Action required | Target phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Financial routing guard | `financial_guard/agent.yaml` + `pkm_agent_lab_service.py` | `Financial Guard Agent -> validator guardrails` | Yes | Validator only | `canonical` | Keep finance routing agent-first and prevent casual prompt drift into governed finance | `sanity -> full` |
| PKM preview and structure | PKM agents + `pkm_agent_lab_service.py` | `Financial Guard Agent -> Memory Intent Agent -> Memory Merge Agent -> PKM Structure Agent -> validator` | Yes | Validator only | `canonical` | Keep hardening prompts, ontology, merge semantics, and live eval | `sanity -> full` |
| PKM persistence | `personal_knowledge_model_service.py` | Deterministic persistence, encryption, manifests, scopes, index writes | N/A | Yes | `deterministic_support` | Keep deterministic; do not move semantics into this layer | steady-state |
| Domain registry | `domain_registry_service.py` | Transitional reference data only | N/A | Yes | `mixed_transitional` | Do not use as runtime semantic source for PKM classification or scope derivation; converge runtime decisions on PKM manifests and index metadata | phase 1 cleanup |
| Consent scopes and token validation | `scope_generator.py`, `scope_helpers.py`, `token.py` | Deterministic scope derivation and authorization | N/A | Yes | `deterministic_support` | Keep deterministic; remove semantic leakage from legacy naming over time | later cleanup |
| Email Helper approved disclosure formatting | `agent_kyc` manifest + client consent gate | Two LLM passes: request routing, then approved-value extraction and draft after local decrypt; the client wraps the draft for Gmail | Yes, within approved scopes | Consent and subset guards | `canonical` | Keep the exact approved field subset and client confirmation before plaintext reaches the LLM; see [One Email KYC](../../../docs/reference/architecture/one-email-kyc.md) | steady-state |
| Legacy domain inferrer | `domain_inferrer.py` | Regex + keyword rule engine | No | No, semantic drift | `drift_or_legacy` | Remove from canonical semantic paths; keep only as migration reference if still needed | phase 1 cleanup |
| Kai semantic flows | `agents/kai/runtime.py` and `operons/kai/llm.py` | Manifest-owned analyst/synthesis turns coexist with direct provider helpers in the operon | Partially | Mixed | `mixed_transitional` | Keep the manifest-owned paths; audit remaining direct helpers by caller and purpose before retiring them | phase 2 review |
| Portfolio import | `agents/portfolio_import/runtime.py` | Manifest-owned ADK extraction genes with deterministic parser adapters | Yes for the inspected extraction path | Parser validation | `canonical` | Preserve structured extraction and parser contracts; live-provider acceptance remains separate | steady-state |
| PKM evaluation harness | `../../scripts/eval_pkm_structure_agent.py` | Live model matrix + synthetic/shadow replay | Yes | Benchmark logic only | `canonical` | Continue phase-based promotion and latency comparison | ongoing |
| Global Gemini default | `constants.py` | `GEMINI_MODEL` (the switched fleet Flash model, one of the last two Gemini releases in the catalog) for general runtime defaults | Yes, PKM manifests name `gemini-default` and resolve here | N/A | `canonical` | One switch moves every text agent; the catalog never carries more than two releases | ongoing |

## Immediate decisions

- PKM classifier semantics are agent-only and canonical.
- Deterministic backend code remains responsible for security, storage, and validation only.
- `domain_inferrer.py` is formally classified as drift, not architecture.
- Remaining direct Gemini helpers require caller-level classification; their presence does not make the manifest-owned Kai or Portfolio Import paths absent.
- PKM is the only accepted product/runtime terminology for user knowledge surfaces.
