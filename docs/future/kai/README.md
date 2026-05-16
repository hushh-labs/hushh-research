# Kai Future Roadmap

> Planning-only home for Kai future-state architecture, assistant workflows, and R&D risk assessment.

## Visual Map

```mermaid
flowchart TD
  root["docs/future/kai/<br/>Kai future roadmap"]
```

## Purpose

Use this directory for Kai concepts that are:

- directionally important
- architecture-relevant
- not yet approved execution work

Kai north stars stay in [../../vision/kai/README.md](../../vision/kai/README.md). Execution-owned Kai contracts belong in `docs/reference/`, `consent-protocol/docs/`, or `hushh-webapp/docs/` once approved.

## Current Concepts

No active Kai future concept files are maintained in this folder right now.
The superseded email/KYC planning note was promoted out of `docs/future/`
because One Email KYC now has execution-owned references.

Current One/Kai/Nav/KYC planning boundaries live in [../one-nav-runtime-plan.md](../one-nav-runtime-plan.md).
Current One Email KYC implementation truth lives in
[../../reference/architecture/one-email-kyc.md](../../reference/architecture/one-email-kyc.md).

## Promotion Rule

When a Kai future concept becomes approved work:

1. keep the original future doc as planning history only if it still adds value
2. split implementation detail into execution-owned docs by subsystem
3. remove any speculative wording from the execution docs
