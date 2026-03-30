# Model Landscape (Feb 2026)


## Visual Context

Canonical visual owner: [Cloud + On-Device AI Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Status

`Future Plan` baseline. Values in this document are planning estimates and must not be treated as production commitments until benchmarked.

## Goal

Provide a planning baseline for cloud + optional on-device AI add-on packs across:

1. OCR/PDF parsing.
2. STT.
3. TTS.
4. SLM reasoning/summarization.

All values below are planning estimates and must be benchmarked on real target devices before implementation lock.

## Device Tiers

| Tier | Example devices | RAM | On-device scope |
| --- | --- | ---: | --- |
| `U0` | Older mid-tier, pre-2022 | <6 GB | Voice + basic OCR only |
| `U1` | iPhone 13/14, Pixel 7, S22 | 6-8 GB | OCR/STT/TTS + 1B SLM option |
| `U2` | iPhone 15/16, Pixel 8/9, S23/S24 | 8-12 GB | Larger STT/SLM packs possible |

## SLM Candidates

| Model | Approx packaged size | Peak RAM | U1 latency (128-token reply) | Fit |
| --- | ---: | ---: | ---: | --- |
| `google/gemma-3-1b-it` (Q4) | 0.5-0.8 GB | 1.2-1.8 GB | 6-15 s | Best size/quality balance |
| `meta-llama/Llama-3.2-1B-Instruct` (Q4) | 0.6-0.9 GB | 1.4-2.0 GB | 8-18 s | Stable fallback |
| `google/gemma-3n-E2B-it` (Q4) | 0.9-1.3 GB | 1.8-2.6 GB | 10-22 s | Better reasoning, heavier |
| `Qwen/Qwen2.5-3B-Instruct` (Q4) | 1.8-2.4 GB | 3.0-4.5 GB | 18-40 s | U2-only quality tier |

## STT Candidates

| Model | Approx packaged size | Peak RAM | U1 latency (30s audio) | Fit |
| --- | ---: | ---: | ---: | --- |
| `openai/whisper-tiny` (INT8) | 80-120 MB | 0.35-0.7 GB | 8-20 s | Fast baseline |
| `openai/whisper-base` (INT8) | 150-220 MB | 0.6-1.1 GB | 12-30 s | Better quality baseline |
| `distil-whisper/distil-small.en` | 300-450 MB | 1.2-2.0 GB | 8-18 s | Best quality-cost (EN heavy) |

## TTS Candidates

| Model | Approx packaged size | Peak RAM | U1 first-audio latency | Fit |
| --- | ---: | ---: | ---: | --- |
| `hexgrad/Kokoro-82M` | 90-140 MB | 0.3-0.7 GB | 0.3-0.8 s | Best compact naturalness |
| `coqui/XTTS-v2` | 1.2-1.8 GB | 2.0-3.5 GB | 1.0-2.5 s | High quality, heavy |

## OCR / PDF Candidates

| Model/pipeline | Approx packaged size | Peak RAM | U1 latency (single page) | Fit |
| --- | ---: | ---: | ---: | --- |
| PaddleOCR mobile pipeline | 30-120 MB | 0.3-0.9 GB | 0.6-1.8 s | Best mobile baseline |
| `microsoft/trocr-base-printed` (Q8) | 300-450 MB | 1.2-2.0 GB | 1.5-4.0 s | Better for clean printed text |
| `naver-clova-ix/donut-base` (Q8) | 350-550 MB | 1.5-2.4 GB | 2.0-5.0 s | Better for structured docs/forms |

## Pathway Comparison

| Pathway | Pack composition | Add-on size | U1 profile | Best for |
| --- | --- | ---: | --- | --- |
| `A: Lean Offline` | PaddleOCR + Whisper Tiny + Kokoro | 180-260 MB | OCR <2s/page, STT 10-20s/30s | Minimal footprint |
| `B: Balanced Hybrid` | Path A + Gemma 1B Q4 | 750-1,050 MB | Adds local SLM (6-15s) | Best product balance |
| `C: Private Pro` | Distil-Whisper + advanced OCR + 2B/3B SLM | 1.8-3.2 GB | Heavy for U1, strong on U2 | Max privacy/offline depth |

## Critical Edge Cases

1. No network and no model pack installed.
2. Corrupt or partially downloaded pack.
3. Low storage during install or inference.
4. Thermal throttling and battery saver.
5. Stale cached context in offline mode.
6. Locale mismatch for OCR/STT/TTS.

## Sources

- Apple Foundation Models: https://developer.apple.com/documentation/foundationmodels
- Android AI docs: https://developer.android.com/ai
- Firebase AI Logic references: https://firebase.google.com/docs/ai-logic
- Hugging Face model pages:
  - https://huggingface.co/google/gemma-3-1b-it
  - https://huggingface.co/google/gemma-3n-E2B-it
  - https://huggingface.co/Qwen/Qwen2.5-3B-Instruct
  - https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct
  - https://huggingface.co/openai/whisper-tiny
  - https://huggingface.co/openai/whisper-base
  - https://huggingface.co/distil-whisper/distil-small.en
  - https://huggingface.co/hexgrad/Kokoro-82M
  - https://huggingface.co/coqui/XTTS-v2
  - https://huggingface.co/microsoft/trocr-base-printed
  - https://huggingface.co/naver-clova-ix/donut-base
