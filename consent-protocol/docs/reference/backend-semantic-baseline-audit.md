# Backend Semantic Baseline Audit


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This audit classifies the current backend semantic surfaces against the agent-only PKM methodology.

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
| Legacy domain inferrer | `domain_inferrer.py` | Regex + keyword rule engine | No | No, semantic drift | `drift_or_legacy` | Remove from canonical semantic paths; keep only as migration reference if still needed | phase 1 cleanup |
| Kai direct Gemini semantic flows | `operons/kai/llm.py` | Direct prompt strings + `generate_content` outside manifest-backed semantic agents | No | No | `drift_or_legacy` | Audit path-by-path; keep domain-specific analysis where needed, but move canonical semantic classification to manifest-backed agents | phase 2 review |
| Portfolio import | `agents/portfolio_import/*` | Manifest-backed agent shell plus direct Gemini extraction calls inside the agent | Partially | Mixed | `mixed_transitional` | Preserve working extraction, but document it as transitional and move toward explicit structured contract ownership | phase 2 review |
| PKM evaluation harness | `../../scripts/eval_pkm_structure_agent.py` | Live model matrix + synthetic/shadow replay | Yes | Benchmark logic only | `canonical` | Continue phase-based promotion and latency comparison | ongoing |
| Global Gemini default | `constants.py` | `gemini-3.1-pro-preview` for general runtime defaults | No, for PKM | N/A | `mixed_transitional` | Keep global default for broad runtime surfaces, but never let PKM classifier inherit it implicitly | immediate doc guard |

## Immediate decisions

- PKM classifier semantics are agent-only and canonical.
- Deterministic backend code remains responsible for security, storage, and validation only.
- `domain_inferrer.py` is formally classified as drift, not architecture.
- Direct Gemini prompt strings outside manifest-backed agents are transitional unless explicitly documented as domain-specific non-PKM analysis.
- PKM is the only accepted product/runtime terminology for user knowledge surfaces.
