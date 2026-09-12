# Backend Semantic Boundary


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document defines what must stay agent-derived and what may remain deterministic.
It is the contract `AGENTS.md` principle 9 points at. Lanes cite it; they never copy it.

## The three shapes this boundary is crossed

A deterministic validator crosses the line in one of exactly three ways. Naming them
separately matters, because each has a different fix and the first two are easy to
mistake for good engineering.

1. **Decides instead.** Host code computes an outcome the agent's own output contract
   already declares, without asking the agent. Measured 2026-09-11:
   `_should_skip_structure_agent` routes around the structure agent for
   `financial_core`, for anything requiring confirmation, and for `save_class` in
   `{ephemeral, ambiguous}` -- and "ambiguous" is precisely the case where a model
   earns its place.

2. **Discards.** The agent answered, and host code overwrites or re-derives a field it
   returned with a non-empty value. Measured on the backend, and since closed: the
   structure agent returns `action`, `externalizable_paths`, `summary_projection` and
   `sensitivity_labels`, all four `required` in its schema, and none was read anywhere.
   `_adopt_model_structure_decision` now reads all four -- `action` validated against
   the schema's own enum, `externalizable_paths` intersected with the paths that
   survived post-model payload mutation, `sensitivity_labels` merged per surviving
   path, and `summary_projection` taken from the model with only `path_count`
   recomputed, because a count is a fact about the payload rather than a judgement
   about it.

   `json_paths` and `top_level_scope_paths` stay walk-derived by design and are not a
   residual defect. `candidate_payload` is sanitized, CRUD-realigned, financially
   normalized, root-scope retargeted and metadata-stripped after the model returns, so
   model-supplied paths would describe a payload that no longer exists. Recording them
   would be a lie about what was written, not deference.

   **Still open:** the frontend manifest overwrites an agent-supplied `consent_label`
   with a title-cased path and re-derives sensitivity, returning `null` for all 47
   leaves of a real document including a loan balance, immigration goals, a full name
   and a home address. That half of the measurement has not been fixed.

3. **Skips.** The stage is routed around so the model is never asked. A skip must be
   recorded in the execution trace and drift flags. Until 2026-09-11 every skip site
   wrote `used_fallback = False`, which is what a SUCCESSFUL call writes, so the one
   promotion gate the live eval had read healthy exactly when the intelligence was
   absent.

**The first legitimate exception is model FAILURE.** A timeout, malformed output, or a
schema violation may be caught by deterministic code, because no agent judgement exists
to respect. A fallback reached only on failure is correct engineering. A fallback reached
on the success path is one of the three shapes above wearing the same name, which is how
`_fallback_structure_decision` came to run on both paths. It still runs on both, but for
a different reason: it is now the base walk over the FINAL payload, the only honest
description of what was actually written, and the model's own fields are adopted over it.

**The second is a data-integrity guard.** A deterministic rule may override a successful
model answer when doing so prevents an unrecoverable, one-directional loss of the
person's own record. The live case is an explicit correction cue: the intent agent
answers `no_op` to "Actually I live in New York City now", and a dropped correction
leaves someone's own record wrong with nothing to tell them it did not take. Unlike
model FAILURE this exception is narrow enough to be abused, so all three conditions must
hold and must be stated at the point the rule applies:

- it prevents a loss that cannot be undone;
- it fires on an explicit signal, not an interpretation;
- it records that it fired, so the rate is readable.

The third condition is what keeps the exception from becoming a second doctrine. A guard
whose recorded disagreement rate reaches zero has been absorbed by the instructions and
must then be deleted. `_sanitize_intent_frame` keeps exactly one rule under this
exception and gates the other five on the model not having answered; every suppressed
rule is logged by name.

Security and authority guards are not semantic decisions and are out of scope here.
Stripping a model-supplied `confirmed` flag, refusing a reserved namespace, and enforcing
consent are correct and must survive this boundary untouched.

## Canonical semantic paths

These paths must derive meaning through ADK/A2A agent stages:

- finance-sensitive routing into Kai core vs sanctioned financial memory
- PKM preview classification
- PKM manifest labelling and sensitivity, including the frontend path
  `hushh-webapp/lib/personal-knowledge-model/manifest.ts`. The boundary is not
  backend-only: a label a person reads at the moment they decide to share is a semantic
  judgement wherever it is computed.
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
- overwrite, re-derive, or recompute any field the agent returned with a non-empty value
- route around an agent stage without recording the skip in the execution trace and drift flags

## Required declaration for new semantic work

Any new semantic backend feature must declare:

- owning agent
- manifest path
- structured output contract
- validator rules
- phase of live eval required before promotion

If a feature cannot provide that declaration, it is not agent-only compliant.
