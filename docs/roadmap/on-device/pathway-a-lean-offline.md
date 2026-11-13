# Pathway A: Lean Offline


## Visual Context

Canonical visual owner: [Cloud + On-Device AI Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Status

`Future Plan` option. This pathway is not implemented yet.

## Summary

Smallest practical add-on pack focused on OCR + voice navigation for offline resilience, without local SLM.

## Target Profile

1. Keep add-on pack near `180-260 MB`.
2. Support `U0` and `U1` devices.
3. Preserve cloud-first analysis in normal online usage.

## Pack Composition

1. OCR: PaddleOCR mobile pipeline.
2. STT: Whisper Tiny (INT8).
3. TTS: Kokoro-82M.
4. SLM: not included.

## Expected Runtime Envelope

| Metric | Target |
| --- | --- |
| OCR p95 | `< 2.0s/page` on U1 |
| STT latency | `10-20s` for `30s` audio |
| TTS first audio | `< 1.0s` |
| Peak RAM | `< 1.5 GB` total active stack |

## Product Behavior

1. Cloud mode remains default for analysis.
2. Offline mode supports parse + voice-only assistance.
3. Any deep reasoning request triggers explicit cloud fallback notice.

## Main Risks

1. Offline summary quality is constrained without local SLM.
2. Whisper Tiny accuracy drops in noisy input.
3. OCR quality can degrade on scanned low-contrast statements.

## Acceptance Gate

1. Add-on install success rate `>= 98%`.
2. Crash-free sessions `>= 99.5%` for pack-enabled clients.
3. Zero blocked primary flows when pack is missing.
