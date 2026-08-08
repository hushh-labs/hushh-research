---
name: deploy-uat
description: Dispatch, watch, and verify a UAT deployment of hushh-research through the governed GitHub Actions lane. Use when asked to deploy to UAT, ship a merged SHA to UAT, check why a UAT dispatch was refused, or when a dispatch attempt produces no workflow run at all. Works for any teammate whose GitHub login is in the UAT allowlist; encodes the token-scope trap that makes dispatches silently never reach GitHub.
---

# Deploy to UAT (hushh-research)

**A dispatch is not a deploy. A green workflow is not a running system.** Done means the new
revision is serving and the live surface answers.

Nothing auto-deploys on merge in this repo. All deploys are manual `workflow_dispatch` of
`deploy-uat.yml`, from `main` only.

## 0. Preconditions — check these before dispatching

1. **Who am I?**
   ```bash
   gh auth status
   ```
   Note the login. Everything below is gated on that exact GitHub username.

2. **Am I on the UAT allowlist?** The workflow's first job runs
   `scripts/ci/assert-governed-actor.py`, which checks the dispatching actor against
   `config/ci-governance.json → uat.manual_dispatch_users`:
   ```bash
   python3 -c "import json; print(json.load(open('config/ci-governance.json'))['uat']['manual_dispatch_users'])"
   ```
   Not listed → do not dispatch. Ask a governance owner (`kushaltrivedi5` or
   `ankitkumarsingh1702`) for a `chore(governance)` PR adding you. That is the whole
   grant process; there is no GitHub-settings step.

3. **Does my token have the `workflow` scope?** This is the trap that looks like nothing:
   the dispatch fails **client-side** and *no run is ever created* — the Actions page stays
   empty, no error appears in the repo. If your dispatches never show up in the run list:
   ```bash
   gh auth refresh -h github.com -s repo,workflow
   ```

## 1. Pick the SHA

Deploy an exact, immutable commit that is on `main` — never a branch name.

```bash
git fetch origin --prune
SHA=$(git rev-parse origin/main)          # or the mergeCommit of the PR you shipped
git merge-base --is-ancestor "$SHA" origin/main && echo "on main: ok"
```

Check the post-merge smoke for that SHA is **green, not queued** — the deploy gate treats a
*queued* smoke run exactly like a red one:

```bash
gh run list --repo hushh-labs/hushh-research --workflow=main-post-merge-smoke.yml --limit 3
```

## 2. Dispatch

```bash
gh workflow run deploy-uat.yml --repo hushh-labs/hushh-research \
  --ref main -f scope=auto -f sha="$SHA"
```

- `--ref main` is mandatory. The `uat` environment's branch policy and the workflow itself
  both refuse any other ref.
- `scope=auto` detects backend/frontend from the diff. Deploying one lane by hand is half a
  release — let `auto` decide unless you have a specific reason.

## 3. Watch it to completion

```bash
sleep 10
RUN_ID=$(gh run list --repo hushh-labs/hushh-research --workflow=deploy-uat.yml \
  --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --repo hushh-labs/hushh-research --exit-status
```

If the run fails at **"Assert manual UAT dispatch actor policy"**, you are not in the
allowlist (step 0.2). If no run appears at all, it is the token scope (step 0.3).

## 4. Verify on the real thing

```bash
# Live journey checks (no GCP access needed)
python3 scripts/ops/verify_live_environment.py --env uat
```

Then open https://uat.one.hushh.ai and walk the flow you shipped — loading, empty, error
states, not just the happy path. Testing from India? US-only directories legitimately return
zero rows on HTTP 200 — follow with a US ZIP (98033) before calling a surface dead.

If you have GCP viewer access, also confirm the serving revision (reads on `hushh-pda-uat`
work; writes are IAM-denied for everyone — that is deliberate):

```bash
gcloud run services describe consent-protocol --region us-central1 --project hushh-pda-uat \
  --format=json | python3 -c "
import json,sys; st=json.load(sys.stdin)['status']
live=next((t for t in st.get('traffic',[]) if t.get('percent')==100), None)
print('serving:', live and live['revisionName'], '| latest:', st.get('latestReadyRevisionName'))
print('IN SYNC' if live and live['revisionName']==st.get('latestReadyRevisionName') else '*** NOT SERVING LATEST ***')"
```

## Hard rules

- **Never** deploy UAT with `gcloud run deploy` by hand. A deliberate IAM deny policy on
  `hushh-pda-uat` blocks manual Cloud Run writes for every human, including project Owners.
  The workflow is the only lane.
- Production is a different workflow (`deploy-production.yml`), a different allowlist
  (2 people), and requires being asked for in those words. UAT access is not production
  authorization.
- Report with evidence: run URL + conclusion, the SHA deployed, and what you saw on the
  live surface — not "should be live".
