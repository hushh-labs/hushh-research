# Testing


## Visual Context

Canonical visual owner: [Quality and Design System Index](docs/reference/quality/README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This file is a repo-root testing entrypoint. The maintained CI and verification reference lives at [`docs/reference/operations/ci.md`](./docs/reference/operations/ci.md).

## Testing Principles

High-signal rules that should remain true regardless of test inventory changes:

- BYOK discipline: tests must not depend on production encryption keys or persistent private credentials.
- Consent-first discipline: token-gated flows should be exercised with explicit test tokens or fixtures, not hidden bypasses.
- Tri-flow discipline: web, proxy, and native-contract changes should keep verification surfaces aligned.

## Current Test Surface

- frontend tests live under `hushh-webapp/__tests__/`
- common frontend areas currently include `api/`, `services/`, `streaming/`, and `utils/`
- backend tests live under `consent-protocol/tests/`
- backend coverage currently includes top-level route/service tests plus focused areas such as `tests/quality/` and `tests/services/`

## Primary References

- CI and required gates: [`docs/reference/operations/ci.md`](./docs/reference/operations/ci.md)
- Route governance: [`docs/reference/architecture/route-contracts.md`](./docs/reference/architecture/route-contracts.md)
- Docs parity and docs governance: [`docs/reference/operations/docs-governance.md`](./docs/reference/operations/docs-governance.md)

## Common Local Commands

```bash
./scripts/test-ci-local.sh
make test
make verify-docs
cd hushh-webapp && npm run verify:routes
cd hushh-webapp && npm run typecheck
cd consent-protocol && pytest tests/ -v
```

Package-specific test setup lives with the package documentation:

- Backend: [`consent-protocol/docs/README.md`](./consent-protocol/docs/README.md)
- Frontend/native: [`hushh-webapp/docs/README.md`](./hushh-webapp/docs/README.md)

## Practical Guidance

- Use `./scripts/test-ci-local.sh` before opening a PR when a change spans multiple surfaces.
- If you touch API routes or plugin contracts, run `cd hushh-webapp && npm run verify:routes`.
- If you touch encryption, consent, or PKM behavior, prefer adding or updating backend tests under `consent-protocol/tests/` and relevant frontend service tests under `hushh-webapp/__tests__/services/`.
