# Advanced Ops


## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Use this after [Getting Started](./getting-started.md). This is the operational layer, not the first-run guide.

## Cloud SQL Proxy

`local-uatdb` can open a local Cloud SQL proxy automatically when the active backend profile points at UAT Cloud SQL.

Use:

```bash
make backend PROFILE=local-uatdb
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
./scripts/test-ci-local.sh
```

Advisory checks remain opt-in:

```bash
INCLUDE_ADVISORY_CHECKS=1 ./scripts/test-ci-local.sh
```

## Deploy

### UAT-First Release Lane

The deployment-first branch for hosted validation is `deploy_uat`.

Recommended sequence:

```bash
# from your working branch
bash scripts/ci/orchestrate.sh all

# then move the approved change into deploy_uat and push that branch
git push origin deploy_uat
```

That branch is wired to [`.github/workflows/deploy-uat.yml`](../../.github/workflows/deploy-uat.yml), which now checks:

- branch contains latest `main`
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

- branch governance
- runtime env/secret parity
- backend/frontend runtime contract injection

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
