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
| KYC disclosure rendering and drafting | `agents/kyc/agent.yaml` + `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts` | Manifest-owned KYC route/redraft/extract model calls receive only workflow-approved exports; the final structured disclosure renderer runs client-side after local decrypt | Yes, within the approved workflow scope | Final renderer only; scoped model drafting is intentional | `canonical` | Keep unapproved/full PKM out of backend context; preserve export-revision and no-log/no-persist checks for transient approved plaintext; do not claim every KYC model step is client-side | steady-state |
| Legacy domain inferrer | `domain_inferrer.py` | Regex + keyword rule engine | No | No, semantic drift | `drift_or_legacy` | Remove from canonical semantic paths; keep only as migration reference if still needed | phase 1 cleanup |
| Kai debate and financial analysis calls | `agents/kai/debate_engine.py`, `agents/kai/{fundamental_agent.py,valuation_agent.py,sentiment_agent.py}` -> `operons/kai/llm.py` | Direct Gemini analysis/streaming calls remain in Kai's financial analysis path; they are not the PKM domain classifier | N/A for PKM classification | No; model analysis is intentional | `mixed_transitional` | Retain these existing finance-analysis entrypoints while tracking their model contract; do not describe them as PKM classification or remove their direct operon path without a parity migration | phase 2 review |
| Portfolio import | `agents/portfolio_import/*` | Manifest-backed agent shell plus direct Gemini extraction calls inside the agent | Partially | Mixed | `mixed_transitional` | Preserve working extraction, but document it as transitional and move toward explicit structured contract ownership | phase 2 review |
| PKM evaluation harness | `../../scripts/eval_pkm_structure_agent.py` | Live model matrix + synthetic/shadow replay | Yes | Benchmark logic only | `canonical` | Continue phase-based promotion and latency comparison | ongoing |
| Global Gemini default | `constants.py` | `GEMINI_MODEL` (the switched fleet Flash model, one of the last two Gemini releases in the catalog) for general runtime defaults | Yes, PKM manifests name `gemini-default` and resolve here | N/A | `canonical` | One switch moves every text agent; the catalog never carries more than two releases | ongoing |

## Immediate decisions

- PKM classifier semantics are agent-only and canonical.
- Deterministic backend code remains responsible for security, storage, and validation only.
- `domain_inferrer.py` is formally classified as drift, not architecture.
- Direct Gemini prompt strings outside manifest-backed agents are transitional unless explicitly documented as domain-specific non-PKM analysis.
- PKM is the only accepted product/runtime terminology for user knowledge surfaces.
