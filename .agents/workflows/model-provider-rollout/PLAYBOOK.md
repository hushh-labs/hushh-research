# Model Provider Rollout Playbook

Use this workflow when upgrading the fleet to a new AI model generation (e.g. rolling supported Gemini releases) or onboarding/changing a runtime AI provider across Vertex AI, Azure OpenAI, BYOK, or on-device adapters.

## Operating Sequence

1. **Cloud & Capacity Pre-Flight (`repo-operations`):**
   - Confirm `vertexai.allowedModels` (`publishers/google/models/<id>:predict`) is allowed at org and per-project scope (`hushh-pda-dev`, `hushh-pda-uat`, `hushh-pda`), `roles/aiplatform.user` is bound on API and worker service accounts in each home project, and Model Garden reports `GA` (or approved preview).
   - Keep UAT and Shared Dev on `$0/mo` Uncapped Dynamic Shared Quota (`-1` DSQ) on `@global`; reserve paid **Provisioned Throughput (GSUs)** strictly for Production on the matching `global` endpoint with `Don't auto-renew`.
2. **Generation Contract & Reasoning Floor (`model-provider-governance`):**
   - Probe live `thinking_level` values (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`) and tool-calling behavior before editing code.
   - Normalize unsupported floors (e.g. `MINIMAL -> LOW`) and strip unsupported legacy sampling fields (`temperature`, `top_p`, `top_k`, `candidate_count`) in `gemini_config.py`.
3. **Full Sub-Agent & Grounded-Tool Audit (`model-provider-governance` + `backend-agents-operons`):**
   - Audit every `agents/*/agent.yaml` sub-agent and every `LlmAgent` / `managed_text_agent` builder (`web_search.py`, `agent_tree.py`) so native Vertex environments (`dev`, `production`, `pods`, `byok`) enforce `thinking_level: low` on interactive chat, `one_intro`, and `google_search`—never relying solely on UAT-only `ManagedPrimaryTextModel`.
   - Ensure grounded search children include a tiered fast-path rule for direct factual lookups and prove latency + `thoughtsTokenCount` via live A/B benchmarks.
4. **Registry Freshness & Gate Verification:**
   - Regenerate `contracts/agents/product-agent-registry.v2.json`, verify `generate_pod_specialist_capability_matrix.py --check` and `generate_capability_graph.py --check`, check module line-count fitness budgets, and run the verification bundle.
5. **Governed Promotion & Live Proof (`repo-operations` + `verify-before-claim`):**
   - Land on `main`, preserve zero `UAT_PRIVILEGED_PATHS` drift across `main`/`uat`/`dev`, promote Production (using a surgical baseline candidate + 3-stage worker connection-budget rollout when `main` holds unapproved DB migrations), and verify `100%` serving revisions, `/health`, direct Vertex inference, and grounded chat turn latency across all three live environments.
