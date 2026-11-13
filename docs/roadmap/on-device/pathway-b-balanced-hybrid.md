# Pathway B: Balanced Hybrid (Recommended)


## Visual Context

Canonical visual owner: [Cloud + On-Device AI Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Status

`Future Plan` option. Recommended for first implementation, but not shipped yet.

## Summary

Recommended first implementation pathway: compact OCR/STT/TTS base plus 1B local SLM for offline reasoning.

## Target Profile

1. Add-on pack `750-1,050 MB`.
2. Focus on `U1` and `U2` devices.
3. Keep cloud-first runtime and use local SLM for offline and degraded network mode.

## Pack Composition

1. OCR: PaddleOCR mobile pipeline.
2. STT: Whisper Tiny or Whisper Base (per locale/perf budget).
3. TTS: Kokoro-82M.
4. SLM: Gemma 1B (Q4).

## Expected Runtime Envelope

| Metric | Target |
| --- | --- |
| OCR p95 | `< 2.0s/page` on U1 |
| STT latency | `10-25s` for `30s` audio |
| SLM 128-token response | `6-15s` on U1 |
| Peak RAM | `2.0-3.0 GB` under mixed workload |

## Product Behavior

1. Cloud mode remains default.
2. Hybrid mode executes OCR/STT/TTS locally and uses cloud fallback when local SLM is unavailable.
3. On-device mode supports full offline summary on cached context.

## Main Risks

1. Pack size may impact install completion on constrained networks.
2. Thermal throttling can increase SLM response time.
3. English-first STT/SLM variants may need locale-specific alternatives.

## Acceptance Gate

1. Offline summary factuality delta within approved threshold versus cloud baseline.
2. U1 p95 latency within matrix bounds for OCR/STT/SLM.
3. Automatic fallback success `>= 99%` when local inference fails.
