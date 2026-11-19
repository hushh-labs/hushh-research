---
name: uat-scoped-deploy
description: Use when choosing, running, or verifying scoped UAT deploys for Hussh Cloud Run services, including frontend-only/backend-only scope, Cloud Build timing proof, Cloud Run region discovery, and service provenance evidence.
---

# Hussh UAT Scoped Deploy Skill

## Purpose and Trigger

- Primary scope: `uat-scoped-deploy-scope`
- Trigger on choosing, running, or verifying a scoped UAT deploy for Cloud Run services.
- Avoid overlap with `repo-context`, broad `repo-operations`, and product implementation owner skills.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `repo-operations`

Owned repo surfaces:

1. `.github/workflows/deploy-uat.yml`
2. `deploy`

Non-owned surfaces:

1. `repo-operations`
2. `frontend`
3. `backend`
4. `security-audit`

## Do Use

1. UAT deploys where `scope=auto` resolves `frontend`, `backend`, or `all` from target-to-deployed-service baselines.
2. Cloud Build timing, skipped-lane, and deploy summary proof.
3. Cloud Run service evidence: project, region, revision, image, timeout, env, traffic, and request-id logs.

## Do Not Use

1. Production deploys unless the user separately asks for production.
2. Product code fixes after deploy verification exposes a frontend/backend bug.
3. Broad CI or release-governance questions not narrowed to UAT deploy scope.
4. Manual browser-only acceptance without runtime or log evidence.

## Read First

1. `.github/workflows/deploy-uat.yml`
2. `deploy/README.md`
3. `deploy/frontend.cloudbuild.yaml`
4. `deploy/backend.cloudbuild.yaml`
5. `docs/operations/releases/branch-governance.md`
6. `.agents/skills/repo-operations/references/admin-release-sop.md`
7. `.agents/skills/uat-scoped-deploy/references/deploy-proof.md`
8. `.agents/skills/uat-scoped-deploy/references/anti-rationalization.md`

## Workflow

1. Default to `scope=auto` so the resolver compares the target SHA against each service's deployed SHA and records both requested and resolved scope.
2. Force `frontend`, `backend`, or `all` only with target-to-deployed-service delta proof covering every accumulated runtime change.
3. Follow `admin-release-sop.md` for queue-first or authorized Admin landing without redefining its exact-head authority gate.
4. Dispatch `deploy-uat.yml` from `main` using only an exact SHA from protected `uat` history; qualify direct candidates against observed serving bases first (see [deploy proof](references/deploy-proof.md) for pins, privilege refusals, and verification selector rules).
5. Watch the GitHub run to terminal success or concrete blocker, confirm skipped lanes, and discover `(project, region)` via the evidence helper before `gcloud run services describe`.
6. Capture touched revisions, images, labels, timeout, traffic, env contracts, request IDs, and logs; read `uat-verification-plan` from the exact changed-SHA selector without replacing it with a local list, and never report queued work as done.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `repo-operations`.
2. Route frontend implementation bugs to `frontend` after preserving deploy evidence.
3. Route backend/API contract bugs to `backend-api-contracts` or `backend`.
4. Route auth, secret, or consent boundary findings to `security-audit`.

## Required Checks

```bash
gh run list --workflow deploy-uat.yml --limit 5 --json databaseId,status,conclusion,headSha,event,url
python3 .agents/skills/uat-scoped-deploy/scripts/cloud_run_service_evidence.py --project hushh-pda-uat --service hushh-webapp --service consent-protocol --format text
python3 .agents/skills/skill-authoring/scripts/skill_lint.py
```
