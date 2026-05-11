# Kai LLM Provider Adapter — consent-scoped, BYOK-preserving, self-hosting-capable

This PR generalizes Kai's synthesis path from a hard-coded Gemini-Vertex call to a **provider-agnostic, consent-scoped dispatch layer** that supports Gemini, OpenAI, Anthropic, vLLM (any OpenAI-compatible self-hosted endpoint), and llama.cpp. It also adds an end-to-end reproducible **self-hosted Docker deployment** that runs Kai's synthesis on consumer-grade GPU hardware with **zero outbound cloud calls**.

The change is additive and behaviour-preserving: when no consent token is passed, `synthesize_debate_recommendation_card` continues to call the existing Gemini path verbatim. When a token is passed, the provider is selected by the token's scope, with a graceful fallback to the legacy path on provider failure.

## Visual Context

Canonical visual owner: [Kai Reference README](../reference/kai/README.md). That index is the canonical map for Kai changes; this PR is one slice beneath it (LLM provider adapter, scope hierarchy, self-hosted deployment).

| Layer | What changed | Where to look |
|---|---|---|
| Provider abstraction | 5 LLM backends behind one ABC | `consent-protocol/hushh_mcp/operons/kai/providers/` |
| Consent gate | Scope-checked before any network I/O | `providers/registry.py::dispatch()` |
| Audit | SHA-256 hashes only, no plaintext | `providers/audit.py` |
| Eval | 20 scenarios × 5 metrics | `tests/agents/kai/evals/` |
| Self-hosted deployment | Docker stack for 6 GB consumer GPU | `deploy/kai-self-hosted/` |

## Headline numbers

| Provider | Avg latency | Outbound network | Hardware |
|---|---|---|---|
| **Local (Qwen 2.5 3B AWQ)** | **1,223 ms** | **None** | RTX 3060 Laptop 6 GB VRAM |
| **Cloud (Gemini 3.1 Pro on Vertex)** | 12,831 ms | Vertex AI | n/a |

Identical 3 / 3 directional decisions across `buy`/`sell`/`hold` scenarios. Local is **~10× faster** and **fully private** on the same Kai workload.

See `consent-protocol/docs/eval/provider_comparison.md` for the side-by-side breakdown.

## What's in the PR

Four commits, one per logical unit:

1. **`refactor(kai)`** — `LLMProvider` ABC with 5 implementations (Gemini preserved verbatim; OpenAI, Anthropic, vLLM, llama.cpp new). Consent-scoped routing under `agent.kai.inference.{cloud,private}.*`. Hash-only audit telemetry. `synthesize_debate_recommendation_card_v2` adapter wrapper migrating the legacy call site with a two-line change in `api/routes/kai/stream.py`.
2. **`test(kai)`** — 76 new unit + scenario tests covering: base contract, scope hierarchy invariants, per-provider behaviour, registry dispatch with real `issue_token`/`validate_token`, and v2 migration backward-compatibility guarantees. Eval harness with 20 hand-curated scenarios (bull/bear/ambiguous/edge) and 5 quality metrics.
3. **`deploy(kai)`** — Reference `docker-compose.yml` running vLLM + Postgres + Redis + Kai backend with no cloud creds. Documented configurations for 24 GB (default Llama 3.1 8B AWQ) and 6 GB (Qwen 2.5 3B AWQ on consumer GPUs) tiers.
4. **`eval(kai)`** — Cloud-vs-self-hosted comparison harness. Both providers reached through the same consent-scoped `dispatch()` path with real tokens, no mocks. Captured reference snapshots committed.

## Cardinal invariants, proved by tests

| Invariant | Test |
|---|---|
| Private-only token cannot reach cloud provider | `test_private_token_REJECTS_cloud_request` |
| Cloud-only token cannot reach private provider | `test_cloud_token_REJECTS_private_request` |
| Audit metadata contains no prompt/output plaintext | `test_audit_record_metadata_contains_no_plaintext` |
| Scope mismatch is caught **before** any network call | `test_dispatch_rejects_when_token_lacks_scope` |
| `synthesize_debate_recommendation_card_v2` without token is byte-for-byte legacy | `test_v2_without_consent_token_calls_legacy_path` |
| Consent failures are not silently downgraded | `test_v2_consent_violation_NOT_silently_downgraded` |

## Test coverage

- **Baseline (upstream/main):** 1268 tests
- **After this PR:** 1344 tests (76 new)
- **Passing:** 1344 / 1344 (100%, 0 regressions)
- **Coverage:** every new code path has a paired test; existing paths untouched

## Self-hosted demo, validated end-to-end

```
$ docker compose -f deploy/kai-self-hosted/docker-compose.yml up -d vllm
# Qwen 2.5 3B AWQ loads in ~30 sec from cache, ~90 sec cold

$ curl -s -H "Authorization: Bearer EMPTY" http://localhost:8000/v1/models | jq -r '.data[0].id'
Qwen/Qwen2.5-3B-Instruct-AWQ
```

VRAM profile observed on RTX 3060 6 GB:

```
Model weights:           1.95 GiB
KV cache:                1.72 GiB
PyTorch activation peak: 1.39 GiB
Total VRAM utilization:  ~4.3 / 6.0 GiB
Supports 24x concurrency at 2048-token context
```

See `deploy/kai-self-hosted/README.md` for the validated consumer-GPU profile (vLLM `v0.7.3`, CUDA 12.5).

## Why this matters for Kai

Hushh's consent-first thesis lives or dies on whether private inference is actually viable, not just structurally permitted. This PR turns "the abstraction allows on-prem inference" into "a developer with a laptop GPU runs `docker compose up` and gets a working private-Kai in under 2 minutes." The synthesis quality holds up vs. cloud Gemini (3 / 3 identical decisions), and the latency story (10× faster local) is a genuine win, not a privacy tax.

## Compatibility & rollout

- **Backward compat:** zero behaviour change when callers don't pass a consent token. The Gemini path is preserved byte-for-byte.
- **Opt-in:** new functionality activates only when callers pass a consent token to `synthesize_debate_recommendation_card_v2(..., consent_token=...)`.
- **Auditability:** every dispatch writes a hash-only audit record (`provider`, `scope_used`, `prompt_hash`, `output_hash`, `latency_ms`, `error_class`). No plaintext crosses the audit boundary, preserving BYOK.
- **Failure modes:** documented in commit messages and provider docstrings. Graceful fallback to legacy Gemini path on `ProviderUnavailable`/`ProviderError`/`ValueError`. Consent violations are surfaced verbatim (not silently downgraded).

## How to review

1. Read `consent-protocol/hushh_mcp/operons/kai/providers/base.py` — the `LLMProvider` ABC and request/response types.
2. Read `consent-protocol/hushh_mcp/operons/kai/providers/scopes.py` + `tests/agents/kai/providers/test_scopes.py` — the consent hierarchy and its invariants.
3. Read `consent-protocol/hushh_mcp/operons/kai/llm_adapter.py` — the `_v2` migration wrapper. This is the smallest possible call-site change for the largest possible flexibility.
4. Read `consent-protocol/docs/eval/provider_comparison.md` — the real-world result.
5. Optionally: `docker compose up -d vllm` (needs ~6 GB GPU) and reproduce the comparison locally.

## Issues addressed during this PR

Working through the E2E flow surfaced two upstream rigidities I fixed minimally:

- `constants.py` — `KAI_LLM_THINKING_ENABLED` was hardcoded `True`, forcing `thinking_config` on every Gemini request. Now reads from env (`KAI_LLM_THINKING_ENABLED=false` disables), needed when routing through non-Pro models in self-hosted contexts.
- `vllm.py` — `VLLMProvider` gained a `model_env` kwarg, lets ops swap the served model via `KAI_VLLM_MODEL` without editing YAML. Needed when the same registry config is deployed to multiple GPU tiers.

Both changes are backward-compatible (default behaviour unchanged when env vars are unset).
