# Kai LLM provider comparison: self-hosted vs cloud

Quick eval over 3 representative scenarios (bull, bear, ambiguous).
Both providers reached via the same consent-scoped `dispatch()` call path.

## Visual Context

| | Local | Cloud |
|---|---|---|
| Provider | vllm | gemini |
| Model | Qwen2.5-3B-Instruct-AWQ | gemini-3.1-pro-preview |
| Hardware | RTX 3060 Laptop 6 GB | Vertex AI managed |
| Outbound network | None | Vertex AI |

## Decision-level results

| Scenario | Local (Qwen 2.5 3B AWQ) | Cloud (Gemini Pro on Vertex) | Match |
|---|---|---|---|
| 01 bull megacap aapl | `buy` (conf 0.85) 1579ms | `buy` (conf 0.85) 11679ms | ✅ |
| 07 bear secular int | `sell` (conf 0.8) 1121ms | `sell` (conf 0.9) 12842ms | ✅ |
| 11 ambiguous dis | `hold` (conf 0.5) 968ms | `hold` (conf 0.6) 13971ms | ✅ |

## Summary

- **Directional agreement:** 3/3 scenarios.
- **Avg latency (local):**  1223 ms (Qwen/Qwen2.5-3B-Instruct-AWQ).
- **Avg latency (cloud):** 12831 ms (gemini-3.1-pro-preview).
- **Local speedup:** 10.5x faster than cloud.
- **Privacy:** local path makes zero outbound calls; verified by audit log inspection.

## Provenance

- Local: vllm provider, Qwen/Qwen2.5-3B-Instruct-AWQ
- Cloud: gemini provider, gemini-3.1-pro-preview
- Routing: consent-scoped dispatch via `hushh_mcp.operons.kai.providers.dispatch()`
- Snapshots: `tests/agents/kai/evals/snapshots/{vllm,gemini}_quick.json`
