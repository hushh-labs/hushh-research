# Advanced Ops


## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Use this after [Getting Started](./getting-started.md). This is the operational layer, not the first-run guide.

## Cloud SQL Proxy

`local` can open a local Cloud SQL proxy automatically when the active backend runtime points at UAT Cloud SQL.

Use:

```bash
./bin/hushh backend
```

Do not replace that with raw `uvicorn` unless you already know the proxy and IAM prerequisites are satisfied.

## Environment And Secret Parity

Check project-level secret presence:

```bash
python3 scripts/ops/verify-env-secrets-parity.py \
  --project hushh-pda-uat \
  --region us-central1 \
  --backend-service consent-protocol \
  --frontend-service hushh-webapp \
  --require-plaid
```

For deployed frontend/backend runtime parity:

```bash
python3 scripts/ops/verify-env-secrets-parity.py \
  --project hushh-pda-uat \
  --region us-central1 \
  --backend-service consent-protocol \
  --frontend-service hushh-webapp \
  --require-plaid \
  --assert-runtime-env-contract
```

## CI

The blocking CI surface stays intentionally small:

1. secret scan
2. web
3. protocol
4. integration

Canonical local parity run:

```bash
./bin/hushh ci
```

Advisory checks remain opt-in:

```bash
./bin/hushh ci --include-advisory
```

## Deploy

### UAT-First SHA Release Lane

The deployment-first path for hosted validation is the latest green `main` SHA.

Recommended sequence:

```bash
# from your working branch
bash scripts/ci/orchestrate.sh all

# merge the approved change into main
# UAT auto-deploys the successful main SHA
```

That workflow is wired through [`.github/workflows/deploy-uat.yml`](../../.github/workflows/deploy-uat.yml), which now checks:

- chosen SHA is reachable from `origin/main`
- chosen SHA already has a successful `CI Status Gate`
- backend/frontend deploy succeeds
- hosted runtime env contract is present on Cloud Run
- UAT parity stays aligned after deploy

Validate the deployed result with:

```bash
python3 scripts/ops/verify-env-secrets-parity.py \
  --project hushh-pda-uat \
  --region us-central1 \
  --backend-service consent-protocol \
  --frontend-service hushh-webapp \
  --require-plaid \
  --assert-runtime-env-contract
```

Deploy workflows already validate:

- SHA governance against `main`
- runtime env/secret parity
- backend/frontend runtime contract injection

Production is no longer an auto-deploy branch lane. It is a manual dispatch of an approved green `main` SHA via [`.github/workflows/deploy-production.yml`](../../.github/workflows/deploy-production.yml).

Reference docs:

- [deploy/README.md](../../deploy/README.md)
- [Branch Governance](../reference/operations/branch-governance.md)
- [CI Reference](../reference/operations/ci.md)

## Native Work

Native/mobile-specific setup stays outside the first-run path:

- [Mobile Guide](./mobile.md)
- `npm run verify:mobile-firebase`
- `npm run verify:parity`

## Developer MCP / External Integrations

For the developer-facing MCP/runtime surface:

- [consent-protocol/docs/mcp-setup.md](../../consent-protocol/docs/mcp-setup.md)
- [docs/reference/operations/coding-agent-mcp.md](../reference/operations/coding-agent-mcp.md)
