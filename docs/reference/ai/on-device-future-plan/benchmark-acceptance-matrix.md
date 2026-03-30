# Benchmark Acceptance Matrix


## Visual Context

Canonical visual owner: [Cloud + On-Device AI Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Status

`Future Plan` quality gate definition. Metrics and thresholds become authoritative only after implementation benchmarks are executed.

## Goal

Define decision gates before any on-device pack is promoted beyond internal testing.

## Test Matrix

| Dimension | Metric | Target | Gate |
| --- | --- | --- | --- |
| OCR | CER/WER and p95 page latency | p95 within chosen pathway | Required |
| STT | WER + real-time factor | Meets pathway target on U1 | Required |
| TTS | First-audio latency + stability | < threshold with no audio glitches | Required |
| SLM | Token throughput + summary factuality | Within quality delta vs cloud baseline | Required for Path B/C |
| Memory | Peak RAM under stress | No OOM on supported tiers | Required |
| Thermal | Sustained run stability | No crash/lock under thermal throttle | Required |
| Reliability | Download resume + checksum recovery | Deterministic recovery pass | Required |
| Privacy | Telemetry payload scan | No sensitive data leakage | Required |

## Scenarios

1. Offline PDF parse using cached docs.
2. Offline STT to summary to TTS chain.
3. Hybrid fallback when local model unavailable.
4. Corrupt pack install and recovery.
5. Low storage and low battery guardrail behavior.
6. Locale mismatch fallback behavior.

## Device Coverage

1. `U0`: basic voice + OCR checks only.
2. `U1`: full acceptance target for initial rollout.
3. `U2`: high-load and larger-pack stress tests.

## Promotion Criteria

1. Two-week benchmark window completed.
2. All required matrix gates pass.
3. Fallback-to-cloud success rate meets target.
4. No P0 crash/regression in core app flows.

## Reporting

1. Store benchmark runs as versioned artifacts per pack + device tier.
2. Track pass/fail trend before expanding allowlist.
3. Record deviations and mitigation notes before promotion.
