# Getting Started

This is the only supported first-run path for contributors.

## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down setup view; this page is the narrower detail beneath it.

## What You Are Booting

Hushh is a monorepo for a consent-and-scope platform:

- `hushh-webapp/`: Next.js + Capacitor client
- `consent-protocol/`: FastAPI backend, consent protocol, PKM, and agents

The product guarantees you should keep in mind while developing:

- **BYOK**
- **zero-knowledge**
- **consent + scoped access**
- **web / iOS / Android contract parity**

## Prerequisites

Required:

- `git`
- `node >= 20`
- `npm >= 10`
- `python3 >= 3.13`
- `jq`

Optional, depending on the work:

- `gcloud` for profile hydration, live parity, and deploy work
- Xcode / Android Studio for native work
- `cloud-sql-proxy` only for the `local` backend path

## First Run

```bash
git clone https://github.com/hushh-labs/hushh-research.git
cd hushh-research
./bin/hushh bootstrap
./bin/hushh web --mode uat
```

`./bin/hushh bootstrap` is the only supported onboarding entrypoint. It:

- installs frontend and backend dependencies
- hydrates the three canonical runtime profiles when cloud access is available
- activates the selected profile into `hushh-webapp/.env.local` and `consent-protocol/.env`
- materializes generated native artifacts under `hushh-webapp/.env.local.d/`
- runs the environment doctor

The default recommended mode is `uat` because it gives you the fastest working app:

- local frontend
- deployed UAT backend
- no local backend boot required

If you are not doing backend work, stop there. Do not start the local backend or Cloud SQL proxy just to work on the app locally.

## Canonical Commands

```bash
./bin/hushh bootstrap
./bin/hushh doctor --mode local
./bin/hushh doctor --mode uat
./bin/hushh doctor --mode prod

./bin/hushh web --mode uat
./bin/hushh web --mode prod
./bin/hushh native ios --mode uat
./bin/hushh native android --mode uat
```

Public docs should not teach legacy root task surfaces or ad hoc env assembly as the normal first-run path.

## Runtime Profiles

Supported modes:

- `local`: local frontend + local backend using UAT-backed resources
- `uat`: local frontend against deployed UAT backend
- `prod`: local frontend against deployed production backend

See [environment-model.md](./environment-model.md) for the exact rules.

## If You Need the Local Backend

The default contributor path does not require it.

When you do need the full local stack:

```bash
./bin/hushh backend
```

That remains a maintainer/deeper-development path, not the primary onboarding contract.

The local backend path is the only place that uses:

- `CLOUDSQL_INSTANCE_CONNECTION_NAME=hushh-pda-uat:us-central1:hushh-uat-pg`
- `CLOUDSQL_PROXY_PORT=6543`

Those keys live only in `consent-protocol/.env`. They are not frontend keys and they are not needed for `uat` or `prod` frontend simulation.

## What Not To Learn On Day One

You do **not** need to understand these to start contributing:

- subtree synchronization for `consent-protocol`
- release promotion mechanics
- one-time migration or rollout runbooks
- manual Firebase/signing artifact fetching

Those exist, but they live in maintainer and operator docs, not the normal contributor path.

## Next Reads

- [environment-model.md](./environment-model.md)
- [../reference/architecture/architecture.md](../reference/architecture/architecture.md)
- [../../contributing.md](../../contributing.md)
