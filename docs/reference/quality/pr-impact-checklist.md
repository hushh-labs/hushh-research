# PR Impact Checklist

Contributor-facing review readiness is defined in
[PR Contributor Readiness Contract](./pr-contributor-readiness.md). Use this
page for impact fields; use the readiness contract for merge expectations,
common blockers, maintainer patch/harvest handling, and attribution rules.

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Mandatory impact mapping for any change touching Kai, PKM, routes, or mobile parity.

## Required PR Fields

- Routes touched
- API/schema/type changes
- Runtime DB data-plane changes
- Cache keys touched
- PKM domain summary effects
- Mobile parity impacts
- Trust boundary touched
- Caller/proxy/backend pairing
- Rollback or safe-failure behavior
- UI browser or Playwright proof
- Docs updated (exact file list)
- Verification commands executed

## Fill-In Template

```md
### Impact Map

- Routes touched:
  - ...

- API/schema/type changes:
  - ...

- Runtime DB data-plane changes:
  - Table families changed: ...
  - Data class / retention / deletion policy updated: yes/no
  - `./bin/hushh codex data-model-audit` run: yes/no

- Cache keys touched:
  - ...

- PKM effects:
  - Domain(s): ...
  - Summary fields changed: ...
  - Reconciliation required: yes/no

- Mobile parity impacts:
  - Route parity: ...
  - Plugin/bridge contract: ...
  - Web-only behavior changes: ...

- Trust boundary touched:
  - Auth/consent/vault/PKM/finance/voice/KYC/deploy/public ingress: ...
  - Privacy or secret exposure impact: ...

- Caller/proxy/backend pairing:
  - Caller changed: ...
  - Backend/proxy changed: ...
  - Contract proof: ...

- Rollback or safe-failure behavior:
  - Rollback path: ...
  - Error/fallback path: ...

- UI browser or Playwright proof:
  - Route/spec/command or not applicable reason: ...

- Docs updated:
  - ...

- Verification run:
  - [ ] `cd hushh-webapp && npm run typecheck`
  - [ ] `./bin/hushh native ios --mode uat` and/or `./bin/hushh native android --mode uat` when mobile behavior changes
  - [ ] `npm run verify:cache`
  - [ ] `npm run verify:docs`
```

## Review Rules

- PR is not review-ready until all required fields are populated.
- “No impact” is allowed only with explicit statement per section.
- Missing verification entries are treated as launch-risk debt.
- Green CI is intake only. Merge readiness also requires a reachable current
  route, caller, package export, generated contract, documented devex entrypoint,
  or canonical production-code test surface.
- Tests that only exercise mocks, copied helpers, or test-local stand-ins do not
  prove production behavior.
