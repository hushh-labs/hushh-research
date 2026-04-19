# Contributing to Hushh Research

Thanks for building with us.

The public contributor model is intentionally small:

```bash
git clone https://github.com/hushh-labs/hushh-research.git
cd hushh-research
./bin/hushh bootstrap
./bin/hushh terminal backend --mode local --reload
./bin/hushh web
```

If you can run that flow and understand the trust model below, you have enough context to contribute.

Choose the narrowest lane that matches the work:

- app contributor: stay in the monorepo root and use `./bin/hushh web` with `./bin/hushh terminal backend --mode local --reload`
- backend contributor: stay in the monorepo root and use `./bin/hushh terminal backend --mode local --reload`
- standalone backend contributor: use the aligned path in [consent-protocol/README.md](./consent-protocol/README.md)
- maintainer/operator: use [docs/reference/operations/README.md](./docs/reference/operations/README.md)

## The Product Contract

Hushh is built around four invariants:

1. **Consent + scoped access**
   - sensitive access is never implicit
   - scope defines what an agent or app may do
   - auditability matters as much as capability
2. **BYOK**
   - the user holds the key boundary
   - vault keys do not become ordinary backend runtime state
3. **Zero-knowledge**
   - the server stores ciphertext and metadata, not plaintext user memory
4. **Tri-flow**
   - web, iOS, and Android stay contract-aligned for shared product capabilities

## Public Contributor Commands

Use these first:

```bash
./bin/hushh bootstrap
./bin/hushh doctor --mode local
./bin/hushh web
./bin/hushh web --mode uat
./bin/hushh native ios --mode uat
./bin/hushh native android --mode uat
```

`./bin/hushh web` defaults to `local`. Use `--mode uat` only when you explicitly want the local frontend against the deployed UAT backend.
`./bin/hushh bootstrap` also defaults to `local`.

Repo-level workflows should go through `./bin/hushh`. Do not teach alternate root task surfaces in contributor docs.

The only setup truth surfaces are:

- `./bin/hushh bootstrap`
- `./bin/hushh doctor --mode <mode>`

## Contributor Contract

- First-party code in this repo is Apache-2.0.
- Every PR commit must be signed off with `git commit -s`.
- `uv` is the canonical Python toolchain for `consent-protocol`.
- `consent-protocol/requirements*.txt` remain generated runtime artifacts only; do not teach them as the install path.
- release migrations are authoritative only from `consent-protocol/db/migrations` + `consent-protocol/db/release_migration_manifest.json`

If you want a zero-setup editor path, use `.devcontainer/devcontainer.json`.

## Branch and Release Model

- All feature and fix work targets `main`.
- UAT deploys automatically from the exact green `main` SHA.
- Production deploys manually from an approved green `main` SHA.
- There are no contributor-facing release branches.

See [docs/reference/operations/branch-governance.md](./docs/reference/operations/branch-governance.md) for the canonical delivery rules.

## Docs You Actually Need

- [README.md](./README.md)
- [docs/guides/getting-started.md](./docs/guides/getting-started.md)
- [docs/guides/environment-model.md](./docs/guides/environment-model.md)
- [docs/reference/architecture/architecture.md](./docs/reference/architecture/architecture.md)

Everything else is either deeper reference or maintainer/operator material.

## Maintainer-Only Complexity

The repo still contains maintainer concerns such as:

- subtree synchronization for `consent-protocol/`
- release/migration governance
- deep operator scripts

Those are real, but they are not part of the normal first-PR path. If you need them, use the maintainer docs under `docs/reference/operations/`.

## PR Expectations

- keep changes small and explainable
- update docs when public behavior or contracts change
- do not add a second setup path when the existing one can be simplified instead
- prefer self-contained scripts and small modules over coupled one-off flows
- run the local verification surface before pushing when your change affects docs, routes, CI, native parity, or backend contracts

Common checks:

```bash
./bin/hushh ci
./bin/hushh docs verify
cd hushh-webapp && npm run verify:docs
```

Commit signoff:

```bash
git commit -s
```

## Naming Policy

Public product/docs language should use **Hushh**.

Selective Secure / Scoped / Handled-by-the-user framing is fine when it clarifies the trust boundary, but it should stay explanatory rather than replacing the product name.

Legacy `Hushh` identifiers may still exist in:

- repo and package names
- bundle IDs
- cloud services
- env keys
- native plugin/class names

Treat those as compatibility details, not public branding.

See [docs/reference/operations/naming-policy.md](./docs/reference/operations/naming-policy.md) for the current rename boundary.
