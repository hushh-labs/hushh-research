# Guides Index

Practical contributor guides live here.

## Visual Map

```mermaid
flowchart TD
  root["Guides"]
  start["Getting Started"]
  env["Environment Model"]
  ops["Advanced Ops"]
  mobile["Mobile"]
  location["One Location UAT"]
  feature["New Feature"]
  a2a["Agent One A2A"]

  root --> start
  root --> env
  root --> ops
  root --> mobile
  root --> location
  root --> feature
  root --> a2a
```

## Canonical Guides

- [getting-started.md](./getting-started.md): the only supported first-run path.
- [environment-model.md](./environment-model.md): the three supported runtime modes.
- [advanced-ops.md](./advanced-ops.md): deeper operator and release workflows.
- [mobile.md](./mobile.md): native/mobile operating model, with child pages for runtime, plugins, build/release, and verification.
- [one-location-uat-test-plan.md](./one-location-uat-test-plan.md): One Location UAT entrypoint, with child pages for setup, sharing, Access Manager, and resilience.
- [new-feature.md](./new-feature.md): implementation checklist when adding product surface.
- [agent-one-a2a-external-developer.md](./agent-one-a2a-external-developer.md): shareable Agent One A2A guide for external developers and partner agent platforms.

## Deeper Guides

- [native_streaming.md](./native_streaming.md): native streaming workflow details.
- [plaid-activation-and-testing.md](./plaid-activation-and-testing.md): Plaid activation and sandbox/live testing.

Subtree synchronization is no longer part of the normal contributor guide surface. Maintainer-only sync notes now belong under operations.
