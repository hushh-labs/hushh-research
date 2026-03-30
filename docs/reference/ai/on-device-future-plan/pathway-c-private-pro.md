# Pathway C: Private Pro


## Visual Context

Canonical visual owner: [Cloud + On-Device AI Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Status

`Future Plan` option. This pathway is not implemented yet.

## Summary

Maximum offline privacy and quality pathway using larger STT/OCR stacks plus 2B/3B SLM options.

## Target Profile

1. Add-on pack `1.8-3.2 GB`.
2. Primarily `U2` devices.
3. Prioritize deep offline capabilities over footprint.

## Pack Composition

1. OCR: TrOCR or Donut-class structured OCR model.
2. STT: Distil-Whisper small.
3. TTS: Kokoro or XTTS (variant by market/device).
4. SLM: 2B/3B quantized model tier.

## Expected Runtime Envelope

| Metric | Target |
| --- | --- |
| OCR p95 | `2.0-5.0s/page` |
| STT latency | `8-18s` for `30s` audio |
| SLM 128-token response | `18-40s` on U1, improved on U2 |
| Peak RAM | `3.0-5.0 GB` workload dependent |

## Product Behavior

1. High-privacy profiles can run substantial workflows offline.
2. Cloud fallback remains available and should never be disabled globally.
3. Pack manager must enforce tier gating by RAM/storage.

## Main Risks

1. Large download and storage burden.
2. Reduced compatibility across older devices.
3. Higher support complexity for multilingual packs.

## Acceptance Gate

1. Only devices passing capability gate can install this pack.
2. Thermal and memory guardrails must prevent crash loops.
3. Recovery path to cloud mode must be immediate and deterministic.
