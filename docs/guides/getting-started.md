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
- `uv`

Optional, depending on the work:

- `gcloud` for profile hydration, live parity, and deploy work
- Xcode / Android Studio for native work
- `cloud-sql-proxy` only for the `local` backend path

## First Run

```bash
git clone https://github.com/hushh-labs/hushh-research.git
cd hushh-research
./bin/hushh bootstrap
./bin/hushh terminal backend --mode local --reload
./bin/hushh web
```

`./bin/hushh bootstrap` is the only supported onboarding entrypoint. It:

- installs frontend and backend dependencies
- hydrates the three canonical runtime profiles when cloud access is available
- activates the selected profile into `hushh-webapp/.env.local` and `consent-protocol/.env`
- runs the environment doctor

Seeded files:

- `consent-protocol/.env`
- generated frontend profile files beside the tracked examples in `hushh-webapp/`
- active frontend runtime in `hushh-webapp/.env.local`

`./bin/hushh bootstrap` and `./bin/hushh web` now both default to `local`.

That local-first path is the recommended maintainer and contributor baseline:

- local frontend
- local backend
- fewer hidden differences from the actual development contract

Use `./bin/hushh web --mode uat` when you want the fastest frontend-only path:

- local frontend
- deployed UAT backend
- no local backend boot required

If you are not doing backend work, stop there. Do not start the local backend or Cloud SQL proxy just to work on the app locally.

If you want a reproducible containerized setup, open the repo through `.devcontainer/devcontainer.json`.

## Choose Your Lane

- App contributor:
  `./bin/hushh terminal backend --mode local --reload` then `./bin/hushh web`
- Backend contributor in the monorepo:
  `./bin/hushh terminal backend --mode local --reload`
- Standalone backend contributor:
  `cd consent-protocol && uv sync --frozen --group dev && ./bin/consent-protocol dev`
- Operator or release maintainer:
  continue into `docs/reference/operations/`

## Canonical Commands

```bash
./bin/hushh bootstrap
./bin/hushh doctor --mode local
./bin/hushh doctor --mode uat
./bin/hushh doctor --mode prod

./bin/hushh web
./bin/hushh terminal backend --mode local --reload
./bin/hushh terminal web --mode local
./bin/hushh web --mode uat
./bin/hushh web --mode prod
./bin/hushh terminal web --mode uat
./bin/hushh native ios --mode uat
./bin/hushh native android --mode uat
```

Public docs should not teach legacy root task surfaces or ad hoc env assembly as the normal first-run path.

Contributor contract:

- first-party repo code is Apache-2.0
- PR commits require `Signed-off-by` (`git commit -s`)
- `uv` is the canonical Python install path for `consent-protocol`

## Runtime Profiles

Supported modes:

- `local`: local frontend + local backend using UAT-backed resources
- `uat`: local frontend against deployed UAT backend
- `prod`: local frontend against deployed production backend

See [environment-model.md](./environment-model.md) for the exact rules.

## Doctor Output

`./bin/hushh doctor --mode <mode>` now separates three states:

- `source contract`: the seeded files and profile values are coherent
- `active profile`: the currently active frontend runtime actually matches the mode you asked for
- `app ready now`: the selected mode can be run immediately without another profile switch

Typical outcomes:

- `ready`: seeded files are valid and the active profile already matches
- `activation_required`: seeded files are valid, but you still need `./bin/hushh env use --mode <mode>`
- `blocked`: the selected mode is missing required files, targets, or secrets

## If You Need the Local Backend

The default contributor path does not require it.

When you do need the full local stack:

```bash
./bin/hushh terminal backend --mode local --reload
./bin/hushh terminal web --mode local
```

That separate-terminal backend + frontend flow is the preferred maintainer path. Use `./bin/hushh terminal stack --mode local` only if you deliberately want one visible terminal window to own both processes.

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
