# AI Model and Provider Upgrade Checklist

Canonical checklist for upgrading supported model generations (such as Gemini fleet rollovers) or adding/changing runtime providers (Vertex AI, Azure OpenAI, BYOK, on-device). Every gate below comes from real production failure modes and must be proven against live infrastructure rather than assumed from configuration.

## 1. Cloud, Org-Policy, and Capacity Readiness (Before Code Cutover)

1. **GCP Organization Policy Allowlist (`vertexai.allowedModels`):**
   - Allowlist `publishers/google/models/<model-id>:predict` at both the organization policy and per-project overrides (`hushh-pda-dev`, `hushh-pda-uat`, `hushh-pda`) while keeping the retiring secondary release allowed during soak and rollback.
   - Allow **30–90 minutes** for Org Policy propagation before treating HTTP `400 FAILED_PRECONDITION` probes as model bugs.
2. **Native Home-Project Trust Boundary:**
   - Each environment binds `GENAI_GOOGLE_CLOUD_PROJECT` to its own home project (`hushh-pda-dev`, `hushh-pda-uat`, `hushh-pda`) on `@global` unless a model requires a regional endpoint. Never couple Production inference to UAT or Dev projects.
   - Verify `aiplatform.googleapis.com` is enabled and both `consent-protocol-runtime@<project>.iam.gserviceaccount.com` and worker identities hold `roles/aiplatform.user`.
   - Confirm `launchStage: GA` (or explicit preview approval) in Model Garden before Production admission.
3. **Environment Capacity Tiering & Billing Continuity:**
   - **Production (`hushh-pda`):** Reserve dedicated **Provisioned Throughput (GSUs)** on the exact serving endpoint (`global` vs regional — mismatched regions bypass reservations!) with **Don't auto-renew** (`3-month` review cadence) so bursts spill over automatically to Dynamic Shared Quota (PayGo) without locking stale model SKUs across retirements.
   - **UAT & Shared Dev:** Keep on `$0/mo` **Uncapped Dynamic Shared Quota (`-1` DSQ)** on `@global`; verify empirical burst capacity (`>= 25` simultaneous requests returning `200 OK` with `0` `429`s) and check 7-day `serviceruntime.googleapis.com/api/request_count` `429` rates.
   - **Billing Account Transitions:** Whenever projects move to a new Billing Account (e.g. credit-card to Invoiced Commitment), immediately re-enable **BigQuery Billing Export** on the new account; export bindings do not carry across billing accounts automatically.

## 2. Generation Parameter & Reasoning-Floor Compatibility

1. **Probe Reasoning Levels Live (`probe_gemini_generation_contract.py`):**
   - Never assume a new generation accepts the prior generation's reasoning enums or budgets. Probe `MINIMAL`, `LOW`, `MEDIUM`, and `HIGH` live against Vertex AI before coding.
   - Example: `gemini-4-hydrogen` rejects `THINKING_LEVEL_MINIMAL` (`400 INVALID_ARGUMENT`) and `thinking_budget`; keep `MINIMAL -> LOW` fleet normalization in `consent-protocol/hushh_mcp/runtime_providers/gemini_config.py`.
2. **Drop Silent No-Op Sampling Fields:**
   - Thinking-first releases ignore or reject legacy `temperature`, `top_p`, `top_k`, and `candidate_count`. Centralize stripping in `gemini_config.py` so callers never rely on silent no-ops, and keep `SUPPORTED_GEMINI_TEXT_MODELS` strictly to the two consecutive supported releases.
3. **Readiness Guardrails:**
   - Follow `.agents/skills/repo-operations/references/managed-provider-readiness.md` before changing any readiness probe, grader, or instruction text that a live gate evaluates.

## 3. Full Agent Tree & Grounded Sub-Agent Audit (The 28-Second Latency Trap)

Pinning only One's root chat head or UAT's `ManagedPrimaryTextModel` wrapper (`ENVIRONMENT == "uat"`) leaves native Vertex environments (`Production`, `Shared Dev`, `Pods`, `BYOK`) exposed on child `AgentTool`s:

1. **Audit Every Root, Child `AgentTool`, and Pre-Vault Head:**
   - Inspect every `consent-protocol/hushh_mcp/agents/*/agent.yaml` entry (`model.thinking_level`) **and** every Python `LlmAgent` / `managed_text_agent` constructor (`web_search.py`, `agent_tree.py`, specialist builders).
   - On frontier reasoning models (`gemini-4-hydrogen`), omitting `thinking_config` on a grounded child such as `google_search` or `one_intro` engages **unbounded dynamic `HIGH` multi-hop reasoning** (`10` sequential Google searches + `2,000+` hidden thinking tokens = `25–29s` unary blocking stall before a single answer token streams).
2. **Enforce Cross-Environment & Cross-Provider Parity:**
   - Ensure native Vertex heads (`dev`, `production`, `pods`, `byok`), UAT `ManagedPrimaryTextModel(primary_provider="vertex")`, and Azure (`default_reasoning_effort="low"` / compact search) all enforce `LOW` thinking on interactive chat and search children without mutating Azure wire payloads.
3. **Tiered Prompt Rules on Grounded Search Children:**
   - Investigative prompts (e.g. profile-research rules) will cause frontier models to run forensic cross-examinations on simple live queries ("weather in Kirkland"). Always pair investigative instructions with an explicit fast-path rule (`<= 2` focused searches and `<= 120` words for direct factual lookups such as weather, time, scores, prices, or schedules).
4. **Live A/B Latency & Token Proof:**
   - Benchmark before/after against the live model endpoint recording wall-clock latency, `thoughtsTokenCount`, `candidatesTokenCount`, and `webSearchQueries` count.

## 4. Model Identity, Contracts, and Fitness Budgets

1. **Synchronize Self-Reported Identity & Catalogs:**
   - Update `HUSSH_GEMINI_TEXT_MODEL` defaults (`constants.py`, `runtime_settings.py`, deploy workflows), `model_catalog.py`, model-preference tests, and any runtime metadata together so live chat never self-reports the retired model name.
2. **Regenerate Derived Registries & Respect Line Budgets:**
   - Run `generate_product_agent_registry.py`, `generate_pod_specialist_capability_matrix.py --check`, and `generate_capability_graph.py --check` whenever `agent.yaml` manifests change.
   - Check `wc -l` on large orchestration/verification modules (`agent_tree.py`, `verify_managed_vertex_runtime.py`) and extract focused helper modules rather than breaching architecture-fitness line caps.

## 5. Multi-Environment Rollout & Live Verification (`repo-operations` + `verify-before-claim`)

1. **Downstream Branch Parity:** Keep `UAT_PRIVILEGED_PATHS` zero-diff across `main`, `uat`, and `dev`.
2. **Surgical Production Baseline Cutover:** When `main` holds unapproved DB migrations, cut a minimal candidate branch off `deployed/production-latest` (`emergency_source_ref`) carrying only the model/runtime delta, stage the worker (`phone_phase=worker`), run two-pass `capacity-maintenance.yml` if needed under the `300`-connection Cloud SQL ceiling, and promote via `phone_phase=standard`.
3. **Post-Cutover Running-Artifact Proof:** Verify `100%` traffic and `HUSSH_GEMINI_TEXT_MODEL` / `GENAI_GOOGLE_CLOUD_PROJECT` on both `consent-protocol` and `consent-protocol-drive-worker` across `hushh-pda-dev`, `hushh-pda-uat`, and `hushh-pda`, `/health` JSON, zero `severity>=ERROR` logs, direct home-project inference, and end-to-end grounded chat latency.
