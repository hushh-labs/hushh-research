---
name: contributor-onboarding
description: Use when changing bootstrap, devcontainer, doctor, or contributor-first-run setup across the monorepo and the standalone consent-protocol path.
---

# Hushh Contributor Onboarding Skill

## Purpose and Trigger

- Primary scope: `contributor-onboarding-intake`
- Trigger on contributor setup, bootstrap flow, devcontainer/Codespaces setup, `doctor` readiness, or monorepo versus standalone onboarding alignment.
- Avoid overlap with `docs-governance`, `repo-operations`, and `backend`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `contributor-onboarding`

Owned repo surfaces:

1. `README.md`
2. `contributing.md`
3. `.devcontainer`
4. `docs/guides/getting-started.md`
5. `scripts/env`
6. `consent-protocol/README.md`
7. `consent-protocol/CONTRIBUTING.md`
8. `.codex/skills/contributor-onboarding`

Non-owned surfaces:

1. `docs-governance`
2. `repo-operations`
3. `backend`
4. `subtree-upstream-governance`

## Do Use

1. One blessed contributor path for the monorepo.
2. Standalone `consent-protocol` onboarding that stays aligned with the monorepo toolchain.
3. Bootstrap, profile hydration, and `doctor` ownership.
4. Devcontainer or Codespaces readiness for contributors.

## Do Not Use

1. Generic docs placement work outside onboarding.
2. Runtime env or deploy secret parity work.
3. Subtree maintainer policy that normal contributors should never see.

## Read First

1. `README.md`
2. `contributing.md`
3. `docs/guides/getting-started.md`
4. `scripts/env/bootstrap.sh`
5. `scripts/env/bootstrap_profiles.sh`
6. `scripts/env/doctor.sh`
7. `consent-protocol/CONTRIBUTING.md`

## Workflow

1. Keep exactly one blessed monorepo contributor path and one aligned standalone upstream path.
2. Keep `uv` as the canonical Python toolchain everywhere contributor docs mention backend setup.
3. Keep secrets hydrated into ignored local files only; onboarding docs must not encourage tracked secrets.
4. Treat `doctor` output as the first-run truth surface for local readiness.
5. Verify onboarding changes twice: once through the direct scripts and once through the canonical repo entrypoint.
6. For bootstrap, devcontainer, or profile-shape contract changes, do a third check before calling the onboarding path stable.
7. Maintainer-only smoke/reviewer overlays must stay outside the canonical contributor runtime contract. RCA or deploy workflows may load them from Secret Manager, but bootstrap must not seed them by default.

## Handoff Rules

1. If the task becomes docs-home governance, use `docs-governance`.
2. If the task becomes CI/deploy/runtime operations, use `repo-operations`.
3. If the task becomes subtree maintainer policy, use `subtree-upstream-governance`.
4. If the task is backend runtime behavior instead of setup flow, use `backend`.

## Required Checks

```bash
./bin/hushh bootstrap --help
./bin/hushh env bootstrap
./bin/hushh doctor --mode local --json
./bin/hushh docs verify
```
