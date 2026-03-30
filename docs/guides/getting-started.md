# Getting Started


## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This is the canonical contributor setup path for the monorepo.

## Prerequisites

Required for the core web + backend contributor flow:

| Tool | Required version | Why |
| --- | --- | --- |
| `git` | current | clone the repo and use worktrees/branches |
| `make` | current | canonical command surface (`make bootstrap`, `make doctor`, `make dev`) |
| `node` | `>=20` | Next.js 16 / frontend toolchain |
| `npm` | `>=10` | lockfile-compatible package install |
| `python3` | `>=3.13` | FastAPI backend, bootstrap, CI parity |
| `jq` | current | profile/bootstrap/deploy helper scripts |

Optional, depending on the work you need to do:

| Tool | Needed when | Notes |
| --- | --- | --- |
| `gcloud` | hydrating profiles from GCP, checking live UAT/prod parity, deploying | bootstrap still works without it, but falls back to templates/cached values |
| `cloud-sql-proxy` | running `local-uatdb` backend | not needed for `uat-remote` or `prod-remote` |
| Xcode / Android Studio | native/mobile work | not part of the core first-run path |

## What You Are Running

- Frontend: Next.js 16 + React 19 + Capacitor
- Backend: FastAPI on Python 3.13
- Storage: Postgres with encrypted PKM blob/index separation
- Auth: Firebase
- Runtime profiles:
  - `local-uatdb`: local frontend + local backend, backed by UAT resources
  - `uat-remote`: local frontend against deployed UAT backend
  - `prod-remote`: local frontend against deployed production backend

## First Run

```bash
git clone https://github.com/hushh-labs/hushh-research.git
cd hushh-research
make bootstrap
make web PROFILE=uat-remote
```

`make bootstrap` is the only supported first-run entrypoint. It:

- configures monorepo hooks and the consent-protocol upstream remote
- installs frontend dependencies
- creates the backend `.venv` and installs requirements
- hydrates the three canonical runtime profiles from GCP when available
- falls back to templates and cached local values when GCP access is unavailable
- runs `make doctor PROFILE=uat-remote`

The default first-run recommendation is `uat-remote` because it is the fastest path to a working app: local frontend, deployed UAT backend, no local backend or Cloud SQL proxy required.

## Canonical Commands

Use these commands instead of manually assembling `.env` files or inventing a new launch flow.

```bash
make doctor PROFILE=local-uatdb
make doctor PROFILE=uat-remote
make doctor PROFILE=prod-remote

make dev PROFILE=local-uatdb
make web PROFILE=uat-remote
make web PROFILE=prod-remote
make backend PROFILE=local-uatdb
```

Use `.venv` as the backend virtual environment. Do not maintain a second `venv` alongside it.

---

## Environment Setup

The canonical env contract is documented in [../reference/operations/env-and-secrets.md](../reference/operations/env-and-secrets.md).

Current default workflow uses runtime profiles rather than ad hoc manual env assembly.

Bootstrap local profiles:

```bash
bash scripts/env/bootstrap_profiles.sh
```

Activate a profile into `consent-protocol/.env` and `hushh-webapp/.env.local`:

```bash
bash scripts/env/use_profile.sh local-uatdb
```

For `local-uatdb`, start the backend with the launcher instead of running
`python`/`uvicorn` directly:

```bash
bash scripts/runtime/run_backend_local.sh local-uatdb
```

That launcher starts the local Cloud SQL proxy automatically when the active
profile points at UAT Cloud SQL. It authenticates the proxy from
`FIREBASE_SERVICE_ACCOUNT_JSON` in the active backend env, or from
`CLOUDSQL_PROXY_CREDENTIALS_FILE` if you set one explicitly. It refuses to
fall back to local `gcloud`/ADC credentials.

Supported profile names:

- `local-uatdb`
- `uat-remote`
- `prod-remote`

Important env rules:

- backend database configuration uses `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, and `DB_NAME`
- backend signing/runtime secrets come from the documented `SECRET_KEY`, Firebase, and Google keys
- frontend runtime uses `NEXT_PUBLIC_*` keys plus server-side fallback keys where documented
- `DATABASE_URL` is not part of the supported runtime contract

---

## Running Locally

Canonical launchers:

```bash
make local
make uat
make prod
```

Shortcut aliases still exist:

```bash
make local-web
make uat-web
make prod-web
make local-backend
```

## Decision Table

| I need to… | Use this profile | Run this |
| --- | --- | --- |
| get the app running as fast as possible on first clone | `uat-remote` | `make web PROFILE=uat-remote` |
| run the full local stack | `local-uatdb` | `make dev PROFILE=local-uatdb` |
| debug the local frontend against UAT | `uat-remote` | `make web PROFILE=uat-remote` |
| inspect production behavior safely from local web | `prod-remote` | `make web PROFILE=prod-remote` |
| run only the local backend | `local-uatdb` | `make backend PROFILE=local-uatdb` |
| confirm a profile is coherent before booting | any | `make doctor PROFILE=<profile>` |
| bootstrap without GCP access yet | `uat-remote` first | `make bootstrap`, then read the doctor output for missing secrets/placeholders |

## Expected Endpoints

For `local-uatdb`:

- frontend: `http://localhost:3000`
- backend: `http://127.0.0.1:8000`
- health: `curl http://127.0.0.1:8000/health`

For remote profiles:

- frontend: `http://localhost:3000`
- backend target is whatever `make doctor PROFILE=<profile>` reports from the canonical profile file

## Important Rules

- Use only `local-uatdb`, `uat-remote`, or `prod-remote`
- Use only the canonical profile files:
  - `consent-protocol/.env.local-uatdb.local.example`
  - `consent-protocol/.env.uat-remote.local.example`
  - `consent-protocol/.env.prod-remote.local.example`
  - `hushh-webapp/.env.local-uatdb.local.example`
  - `hushh-webapp/.env.uat-remote.local.example`
  - `hushh-webapp/.env.prod-remote.local.example`
- Do not rely on `*.dev.local`, `*.uat.local`, or `*.prod.local`
- Do not rely on server-side localhost or production fallbacks in hosted environments
- Do not run local UAT DB access with raw `uvicorn`; use `make backend PROFILE=local-uatdb`

## Verification Before You Start Coding

```bash
bash scripts/ci/orchestrate.sh all
make doctor PROFILE=uat-remote
make verify-docs
```

## Next Reads

- [Environment Model](./environment-model.md)
- [Advanced Ops](./advanced-ops.md)
- [Architecture](../reference/architecture/architecture.md)
