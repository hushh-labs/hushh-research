# CI Configuration Reference

This document describes the **Tri-Flow CI** workflow and how to stay aligned with it so code changes do not fail CI. Run local checks before every commit.

**Workflow file:** [.github/workflows/ci.yml](../../../.github/workflows/ci.yml)  
**Local mirror:** [scripts/test-ci-local.sh](../../../scripts/test-ci-local.sh)  
**Orchestrator:** [scripts/ci/orchestrate.sh](../../../scripts/ci/orchestrate.sh)

---

## Fundamental Blocking Policy

To prevent CI check-sprawl, only these checks are hard-blocking by default:

1. `scripts/ci/secret-scan.sh`
2. `scripts/ci/web-check.sh`
3. `scripts/ci/protocol-check.sh`
4. `scripts/ci/integration-check.sh`

The local parity script mirrors those same blocking stages. On GitHub, `main` should require both `CI Status Gate` and `Main Freshness Gate` so the remote gate matches the local one-command CI plus the branch-up-to-date policy.

## When CI Runs

| Trigger | Branches | Behavior |
|--------|-----------|----------|
| Pull request | All branches (`**`) | Full CI (path-filtered) |
| Push | `main`, `deploy_uat`, `deploy` | Full CI (path-filtered for normal changes, forced on release lanes when needed) |
| Merge queue | `main` | Full CI (frontend + backend forced on) |
| Manual | Any | **workflow_dispatch** with scope: `frontend` \| `backend` \| `all` |

**Path filters:** Jobs run only when relevant paths change for `push`/`pull_request` (or when run manually with a scope). Merge queue runs both stacks for deterministic gating.

- **Frontend job** runs when `hushh-webapp/**` changes.
- **Backend job** runs when `consent-protocol/**` changes.
- **Integration job** runs when either frontend or backend paths change.

### Duplicate-Run Policy

Feature and hotfix branches intentionally rely on `pull_request` CI only. This avoids the same head SHA fan-out that happens when a branch triggers both:

1. a `push` run, and
2. one or more `pull_request` runs for different base branches.

Protected release branches still keep `push` CI:

- `main`
- `deploy_uat`
- `deploy`

That keeps one authoritative post-merge CI run on each release lane without duplicating feature-branch noise.

---

## Global Gates (Always Run)

| Gate | Purpose | Behavior |
|------|---------|----------|
| Secret Scan | Detect leaked credentials/tokens early | `gitleaks` OSS CLI (license-free) scans the event commit range, not full repo history |
| Upstream Sync | Detect monorepo/subtree drift | Advisory only; warnings are non-blocking |
| Main Freshness Gate | Prevent stale PR merges into `main` | Blocks pull requests targeting `main` unless the branch contains latest `origin/main` |
| Release Lane Gate | Prevent invalid promotions into `deploy_uat` or `deploy` | Blocks PRs targeting release branches unless the head branch is `main` and it contains latest `origin/main` |
| Branch Freshness Advisory | Early stale-branch signal on feature-branch pushes | Warn-only; does not block CI or merges |
| CI Status Gate | Single required check for branch protection | Fails if any required job fails/cancels/times out; allows intentional `skipped` jobs |

## Live GitHub Enforcement

Protected branches are expected to enforce the same CI contract documented here:

- `main`
  - at least `1` approving review
  - required status checks: `CI Status Gate`, `Main Freshness Gate`
  - strict/up-to-date checks enabled
- `deploy_uat`
  - at least `1` approving review
  - required status checks: `CI Status Gate`, `Release Lane Gate`
- `deploy`
  - at least `1` approving review
  - required status checks: `CI Status Gate`, `Release Lane Gate`
- force-pushes disabled
- branch deletion disabled

The live GitHub setting can drift from the docs, so verify it directly:

```bash
./scripts/ci/verify-main-branch-protection.sh
```

Current live nuance:

- the repo currently uses classic branch protection rather than GitHub repository rulesets
- bypass actors should be limited to the 3 core owners, without overlapping push-restriction lists

## Advisory Checks (Non-Blocking By Default)

1. `scripts/ci/docs-parity-check.sh`
2. `scripts/ci/subtree-sync-check.sh`
3. `npm run verify:design-system`
4. `npm run verify:investor-language`
5. Native parity checks (`verify:parity`, `verify:capacitor:*`) for native release lanes
6. `scripts/ops/verify-env-secrets-parity.py` for release preflight and deployment readiness
7. Broad full-suite pytest runs and Kai accuracy/compliance suites

Do not add new CI/parity scripts without replacing or consolidating an existing check.

### Script Lifecycle Policy

1. Add a new CI/helper script only when it replaces or consolidates an existing one in the same PR.
2. Every CI/helper script must have a clear owner (`frontend`, `backend`, or `platform`) in PR notes.
3. Any CI scope expansion requires reviewer approval from the owning team.

## Branch Lanes

1. `main` is the only integration branch for day-to-day development.
2. `deploy_uat` is the UAT rollout lane and must contain the latest `main`.
3. `deploy` is the production release lane and must contain the latest `main`.
4. `deploy_uat` auto-deploys only after successful protected-branch CI.
5. `deploy` auto-deploys only after successful protected-branch CI.
6. Manual deploy dispatch remains an emergency rerun path, not the default release path.
7. Feature or hotfix branches should never target `deploy_uat` or `deploy` directly; promote through `main`.

See [Branch Governance](./branch-governance.md).

---

## Required Versions (Must Match CI)

| Tool | CI Version | Local requirement |
|------|------------|-------------------|
| Node.js | 20 | 20+ (see [test-ci-local.sh](../../../scripts/test-ci-local.sh)) |
| Python | 3.13 | 3.13 (CI asserts exactly 3.13) |
| npm | latest | Use latest (script upgrades before run) |
| pip | latest | Use latest (script upgrades before run) |

Using a different Node or Python locally can cause “pass locally, fail in CI” if behavior or dependencies differ.

---

## Frontend Checks (Web / Next.js)

**Working directory:** `hushh-webapp/`

| Step | Command / behavior | Fails CI? |
|------|--------------------|-----------|
| Validate files | `package-lock.json` exists and valid JSON; `next.config.ts` exists | Yes |
| Install | `npm ci` | Yes |
| TypeScript | `npm run typecheck` | Yes |
| Lint | `npm run lint -- --max-warnings=${WEB_LINT_WARNING_BUDGET}` | Yes |
| Build (web) | `npm run build` (Next.js) | Yes |
| Security audit budget | `npm audit --json` + budget gate (`moderate/high/critical`) | Yes |
| Tests | `npm run test:ci` (manifest-driven curated suites) | Yes |

**Build env (CI):** `NEXT_PUBLIC_BACKEND_URL` and all six `NEXT_PUBLIC_FIREBASE_*` vars are set to placeholders in the workflow so the build does not depend on real secrets.

**Coding rules that affect CI:**

- Do **not** use `fetch("/api/...")` in components or pages; use the service layer (see [Architecture](../architecture/architecture.md)).
- ESLint must pass with zero warnings (`--max-warnings=0`).
- TypeScript must compile with no errors.

---

## Backend Checks (Python / FastAPI)

**Working directory:** `consent-protocol/`

| Step | Command / behavior | Fails CI? |
|------|--------------------|-----------|
| Validate files | `requirements.txt` exists; optional `requirements-dev.txt`, `tests/` | No (warnings only) |
| Install | `pip install -r requirements.txt` then `requirements-dev.txt` or pytest/mypy/ruff | Yes |
| Lint | `python -m ruff check .` | Yes |
| Type check | `python -m mypy --config-file pyproject.toml --ignore-missing-imports` | Yes |
| Security | `python -m bandit -r hushh_mcp/ api/ -c pyproject.toml -ll` | Yes |
| Tests | `bash scripts/run-test-ci.sh` (manifest-driven curated suites) | Yes |

Blocking backend manifest:

1. `consent-protocol/scripts/test-ci.manifest.txt`
2. Keep this manifest small and stable.
3. Full historical suites remain available through `make test`.
4. Kai accuracy/compliance remains manual through `make accuracy`.

**Test env (CI):**  
`TESTING=true`, `SECRET_KEY`, and `VAULT_ENCRYPTION_KEY` are set in the workflow (see [ci.yml](../../../.github/workflows/ci.yml)).

**Consent-token rule for automated tests:** Use fixture-issued VAULT_OWNER tokens from `consent-protocol/tests/conftest.py`. `consent-protocol/tests/dev_test_token.py` is debug-only and must not be required by CI.

**Config files:**

- **Ruff:** [consent-protocol/pyproject.toml](../../../consent-protocol/pyproject.toml) — `[tool.ruff]` and `[tool.ruff.lint]`. Target Python 3.13, line-length 100, selected rules (E, F, B, I, S), per-file ignores for tests and routes.
- **Mypy:** Same `pyproject.toml` — `[tool.mypy]`. Python 3.13, `warn_return_any`, `ignore_missing_imports`, overrides for `hushh_mcp.*` and consent/vault.

**Coding rules that affect CI:**

- Use **Python 3.13**-compatible syntax and types.
- Avoid ambiguous names (e.g. single-letter `l`) so Ruff doesn’t flag them.
- Optional args: use `Optional[T] = None`, not `T = None`, to satisfy mypy.
- Return types: avoid returning untyped `Any` from functions that declare a concrete return type; use `cast()` or correct types so mypy passes.
- New backend code under `consent-protocol/` is type-checked and linted; keep `api/` and `db/` aligned with mypy and Ruff.

---

## Integration Check (Route Contracts)

**Runs when:** Frontend or backend paths change (or manual run with scope that includes either).

| Step | Command / behavior | Fails CI? |
|------|--------------------|-----------|
| Install | `npm ci` in `hushh-webapp/` | Yes |
| Verify | `npm run verify:routes` (script: `hushh-webapp/scripts/verify-route-contracts.cjs`) | Yes |

Route contracts must stay in sync between frontend expectations and backend (or proxy) routes. See [API Contracts](../architecture/api-contracts.md). If you add or change API routes, update the contract and run `npm run verify:routes` (or full local CI).

---

## Streaming Contract Gates

Canonical streaming is a production contract, not an implementation detail.

- Contract source: [Streaming Contract](../streaming/streaming-contract.md)
- Runtime pattern: [Streaming Implementation Guide](../streaming/streaming-implementation-guide.md)
- Vertex constraints: [Vertex AI Streaming Notes](../streaming/vertex-ai-streaming-notes.md)

Minimum checks for streaming changes:

- Frontend stream checks: `cd hushh-webapp && npm run test:ci` (includes streaming/parser suites)
- Backend stream/auth tests: `cd consent-protocol && pytest tests/test_kai_auth_matrix.py`

---

## Running CI Locally (Before Every Commit)

**Recommended:** Run the script that mirrors CI. It uses the same versions and steps as GitHub Actions.

```bash
./scripts/test-ci-local.sh
```

This script:

1. Validates required files (e.g. `package-lock.json`, `next.config.ts`, `requirements.txt`, test files).
2. Checks Node (20+) and Python (3.13) and upgrades npm/pip.
3. Runs **frontend** checks: install, `tsc`, lint, Next build, audit-budget gate, curated test suite.
4. Runs **backend** checks: shared parity verification, install, Ruff, mypy, Bandit, curated test suite.
5. Runs **integration**: route/runtime contract verification.

To include advisory checks locally:

```bash
INCLUDE_ADVISORY_CHECKS=1 ./scripts/test-ci-local.sh
```

To verify the live GitHub branch gate matches the documented minimum contract:

```bash
./scripts/ci/verify-main-branch-protection.sh
```

If it exits 0, CI should pass. If it fails, fix the reported step before committing.

Secret-scan note:

- local and remote CI now both scan the relevant commit range by default
- use `GITLEAKS_LOG_OPTS=--all` only when you intentionally want a full-history audit

---

## Quick Reference: Commands That Must Succeed

| Area | Commands (from repo root) |
|------|----------------------------|
| Frontend | `cd hushh-webapp && npm ci && npm run typecheck && npm run lint -- --max-warnings=0 && npm run build && npm run test:ci` |
| Backend | `cd consent-protocol && pip install -r requirements.txt -r requirements-dev.txt && ruff check . && mypy --config-file pyproject.toml --ignore-missing-imports && bandit -r hushh_mcp/ api/ -c pyproject.toml -ll && bash scripts/run-test-ci.sh` |
| Integration | `cd hushh-webapp && npm ci && npm run verify:routes` |
| All | `scripts/test-ci-local.sh` |

---

## Strict Launch Gate (Release Cut)

Before creating a release tag/public rollout, run strict gate commands from repo root:

```bash
cd hushh-webapp && npm run verify:routes
cd hushh-webapp && npm run verify:parity
cd hushh-webapp && npm run verify:capacitor:routes
cd hushh-webapp && npm run verify:cache
cd hushh-webapp && npm run verify:docs
python scripts/ops/verify-env-secrets-parity.py --project hushh-pda --region us-central1 --backend-service consent-protocol --frontend-service hushh-webapp
bash scripts/verify-pre-launch.sh
```

Blocking rule:
- Launch gate is strict-blocking. Any failing check or non-clean git tree is a release blocker.

## Production Deploy DB Governance Gates

The production deploy workflow (`.github/workflows/deploy-production.yml`) enforces additional DB governance before backend deploy:

1. Supabase backup posture gate:
- validates logical backup freshness from GCS manifests via `scripts/ops/logical_backup_freshness_check.py`
- requires latest successful backup age within configured threshold (`BACKUP_MAX_AGE_HOURS`, default `30`)
- optional manual predeploy backup execution via workflow input `run_predeploy_backup_job=true`

2. Migration governance + drift gate:
- checks migration filename monotonicity (`consent-protocol/db/migrations`)
- checks the production-pinned schema contract (`consent-protocol/db/schema_contract/prod_core_schema.json`)
- allows the repo to be ahead of production while production stays pinned to its approved migration floor
- checks live DB schema contract in read-only mode

3. Manifest artifact:
- emits a production migration release manifest with logical backup evidence (`backup_object_uri`, checksum, completion timestamp)

UAT deploys use a separate latest-integrated contract:

- `consent-protocol/db/schema_contract/uat_integrated_schema.json`

The daily scheduled workflow `.github/workflows/prod-supabase-backup-posture.yml` runs the same backup posture policy and uploads a report artifact.

---

## Related Docs

- [Getting Started](../../guides/getting-started.md) -- Setup and local CI instructions.
- [API Contracts](../architecture/api-contracts.md) -- API contract verification.
- [Architecture](../architecture/architecture.md) -- Tri-Flow and service-layer rules.
- [Streaming Contract](../streaming/streaming-contract.md) -- Canonical SSE contract.

---

## Upstream CI (consent-protocol standalone)

The consent-protocol has its own full CI pipeline at [hushh-labs/consent-protocol](https://github.com/hushh-labs/consent-protocol/actions). It now runs on all branches plus merge queue and includes: secret scan, lint, typecheck, test, security scan, Docker build verification, and a final status gate.

The monorepo `protocol-check` job is a lightweight mirror. For full coverage, PRs to the upstream repo are the authoritative gate.
