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

1. UAT deploys where scope must stay `frontend`, `backend`, or `all`.
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
5. `.codex/skills/uat-scoped-deploy/references/deploy-proof.md`

## Workflow

1. Classify the intended scope from changed paths and user request: `frontend`, `backend`, or `all`.
2. Use `scope=frontend` for UI/auth-route-only changes and `scope=backend` for protocol/API-only changes.
3. Trigger UAT from a green `main` SHA; keep merge, post-merge smoke, and UAT deploy as separate evidence.
4. Watch the GitHub run until terminal success or a concrete blocker; confirm skipped lanes from run steps.
5. Before Cloud Run `describe`, run the evidence helper to discover the actual project/region tuple.
6. Capture touched-service revision, image, labels, timeout, traffic, env contracts, request IDs, and logs.
7. Report run URL, scope, skipped lanes, timings, revisions, and remaining risk; never call queued work done.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `repo-operations`.
2. Route frontend implementation bugs to `frontend` after preserving deploy evidence.
3. Route backend/API contract bugs to `backend-api-contracts` or `backend`.
4. Route auth, secret, or consent boundary findings to `security-audit`.

## Required Checks

```bash
gh run list --workflow deploy-uat.yml --limit 5 --json databaseId,status,conclusion,headSha,event,url
python3 .codex/skills/uat-scoped-deploy/scripts/cloud_run_service_evidence.py --project hushh-pda-uat --service hushh-webapp --service consent-protocol --format text
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
```
