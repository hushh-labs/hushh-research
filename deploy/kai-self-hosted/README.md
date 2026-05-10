# Kai Self-Hosted Reference Deployment

This directory ships a working **fully self-hosted Kai stack** -- the Kai
backend, Postgres, Redis, and a CUDA-accelerated **vLLM** instance serving
Llama 3.1 8B Instruct (AWQ-quantized) -- glued together with the new
provider adapter so all inference happens on your own GPU.

It is the deployable artifact behind Hushh's consent-first promise:
**no portfolio data leaves your hardware**.

---

## Why this exists

Hushh's value proposition stops at "we don't store plaintext on the
server"; the inference call itself is still a third-party request to
Google. For enterprise customers (RIAs, family offices, regulated funds)
that distinction matters: every prompt to Gemini is a regulated data
disclosure under their compliance regime.

This deployment removes that disclosure entirely. The Kai backend is
configured with a consent token whose only authorized inference scope
is `agent.kai.inference.private.self_hosted`. The provider adapter will
**refuse** to route to any cloud provider with that token -- no code
change, no redeploy, just a different scope on the issued token.

---

## Hardware

| GPU class      | Recommended model                                      |
| -------------- | ------------------------------------------------------ |
| 24 GB (e.g. RTX 4090 / L4 / A10G) | Meta-Llama-3.1-8B-Instruct AWQ INT4 (default) |
| 48 GB (RTX 6000 Ada / A6000)      | Qwen 2.5 14B Instruct AWQ |
| 80 GB (A100 / H100)               | Meta-Llama-3.1-70B-Instruct AWQ INT4 |

Override via `.env`:

```bash
KAI_VLLM_MODEL=Qwen/Qwen2.5-14B-Instruct-AWQ
```

If your card is smaller than 24 GB you can run a 4 B model
(`Qwen/Qwen2.5-3B-Instruct-AWQ`) but expect noticeably weaker
calibration on the eval harness.

---

## Setup

```bash
# 1. Install the NVIDIA container toolkit on the host (one-time):
#    https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/

# 2. Configure secrets:
cp deploy/kai-self-hosted/.env.example .env
$EDITOR .env   # set APP_SIGNING_KEY, VAULT_DATA_KEY, HF_TOKEN

# 3. Bring the stack up (first run will pull + cache the model; ~6-10 min):
docker compose -f deploy/kai-self-hosted/docker-compose.yml up -d

# 4. Verify:
curl http://localhost:8000/v1/models    # vLLM
curl http://localhost:8080/health       # Kai backend
```

---

## Smoke test

Run three queries through the full debate engine via the adapter:

```bash
uv run python tests/agents/kai/evals/compare.py \
    --baseline gemini --candidate vllm --limit 3 \
    --out reports/eval_self_hosted_smoke.json \
    --markdown reports/eval_self_hosted_smoke.md
```

This produces a side-by-side comparison showing Brier score, evidence
grounding, debate convergence, and latency for the same three scenarios
on Gemini vs. self-hosted Llama. Paste the markdown into the PR.

---

## Eval comparison (full)

```bash
# Run the full 20-scenario eval harness against self-hosted:
uv run python tests/agents/kai/evals/compare.py \
    --baseline gemini --candidate vllm \
    --out reports/eval_compare.json \
    --markdown reports/eval_compare.md
```

Expected ranges (Llama 3.1 8B AWQ vs. Gemini 3 Flash):

* Recommendation calibration (Brier): within 30% delta. Gemini's larger
  context window and instruction-following give it a small edge on
  ambiguous cases.
* Evidence grounding: within 15% delta. Both models cite numbers when
  given clear inputs.
* Debate convergence: very close. Convergence is mostly a function of
  prompt design, which is identical across providers.
* Latency p95: self-hosted is typically 2-4x faster than cloud Gemini
  for short prompts on a 4090; the network round trip dominates.

(Numbers will vary by your hardware. Capture yours and put them in the
PR description -- they're the most credible artifact you have.)

---

## Tearing down

```bash
docker compose -f deploy/kai-self-hosted/docker-compose.yml down -v
```

`-v` removes the Postgres volume; the HF model cache survives in the
`hf-cache` volume so subsequent boots don't redownload.

---

## Troubleshooting

* **vLLM stuck at "Loading model"** -- you're hitting HF rate limits or
  the token doesn't have model access. Check `docker logs kai-vllm`.
* **OOM on model load** -- drop `KAI_VLLM_MAX_MODEL_LEN` to 4096 or use
  a smaller AWQ model.
* **Adapter falls back to Gemini despite KAI_SYNTHESIS_PROVIDER=vllm** --
  the consent token issued in your test run authorizes Gemini too, and
  vLLM is currently unhealthy. Watch `docker logs kai-vllm` and
  re-issue a token with only `agent.kai.inference.private.self_hosted`
  to force an explicit failure if vLLM is down.

---

## Operational notes

* All cloud-provider env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GOOGLE_APPLICATION_CREDENTIALS`) are explicitly **unset** by the
  compose file. The adapter would refuse them anyway via consent
  scopes, but clearing them makes the "no data leaves the box" claim
  auditable: `env | grep -E '(OPENAI|ANTHROPIC|GOOGLE)'` returns empty
  inside the container.
* The `consent_audit` table inside Postgres records every inference
  call with hash-only metadata. Inspect with:

  ```bash
  docker exec -it kai-postgres psql -U kai -d kai \
      -c "SELECT scope, action, metadata->>'provider', metadata->>'latency_ms' \
          FROM consent_audit WHERE metadata->>'kind' = 'kai_inference' \
          ORDER BY issued_at DESC LIMIT 10;"
  ```

## Validated configuration: RTX 3060 6 GB (consumer laptop)

The default configuration assumes a 24 GB+ enterprise GPU. For developers
without enterprise hardware, the following profile is validated end-to-end
on a single RTX 3060 Laptop (6 GB VRAM):

```env
KAI_VLLM_MODEL=Qwen/Qwen2.5-3B-Instruct-AWQ
KAI_VLLM_QUANTIZATION=awq_marlin
KAI_VLLM_MAX_MODEL_LEN=2048
KAI_VLLM_GPU_MEM_UTIL=0.85
```

Plus pin the vLLM image to a CUDA-12.4-compatible release in
`docker-compose.yml`:

```yaml
image: vllm/vllm-openai:v0.7.3
```

Observed resource usage during inference:

- Model weights: 1.95 GiB
- KV cache: 1.72 GiB
- PyTorch activation peak: 1.39 GiB
- Total VRAM utilization: ~4.3 / 6.0 GiB (with 0.85 utilization cap)
- Supports 24x concurrency at 2048-token context

See `docs/screenshots/phase5_qwen_inference.png` for end-to-end validation
output.
