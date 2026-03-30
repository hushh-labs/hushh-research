# Backend Semantic Boundary


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document defines what must stay agent-derived and what may remain deterministic.

## Canonical semantic paths

These paths must derive meaning through ADK/A2A agent stages:

- finance-sensitive routing into Kai core vs sanctioned financial memory
- PKM preview classification
- PKM structure planning
- future generalized user-memory interpretation

Required shape:

- manifest-backed prompt
- exact structured output
- deterministic post-validation

## Deterministic support paths

These paths should remain deterministic by design:

- consent enforcement
- trust-link and token validation
- encryption and decryption
- manifest persistence
- scope persistence
- route/auth plumbing
- caching
- telemetry
- transport retries and timeouts

These are safety and infrastructure concerns, not semantic classification concerns.

## Drift and legacy paths

These paths are allowed temporarily but must be treated as migration targets or compatibility layers:

- regex or keyword domain inference
- direct Gemini semantic prompts outside manifest-backed agents
- any leftover legacy naming or storage shims influencing PKM behavior
- service-local semantic fallbacks that invent meaning

## Allowed validator behavior

Deterministic validators may:

- check contract coherence
- reject unresolved or unsafe output
- normalize storage-safe structure
- enforce no-`general` policy
- prevent finance contamination

Deterministic validators may not:

- become the primary semantic classifier
- create ontology labels the agents did not choose
- replace domain selection with hardcoded business heuristics

## Required declaration for new semantic work

Any new semantic backend feature must declare:

- owning agent
- manifest path
- structured output contract
- validator rules
- phase of live eval required before promotion

If a feature cannot provide that declaration, it is not agent-only compliant.
