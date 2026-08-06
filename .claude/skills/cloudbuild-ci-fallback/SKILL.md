---
name: cloudbuild-ci-fallback
description: Run CI and deploy through GCP Cloud Build when GitHub Actions is unavailable. Use when Actions runs sit queued, when deploy-uat or deploy-production fails at "Validate deployment SHA against main", when someone says "GitHub Actions is down" / "deployment is down" / "runners are stuck", or when a release must ship and the governed workflow cannot be scheduled. Encodes which lanes are reachable from a laptop, which are locked by IAM policy, and the Cloud Build substitution rule that silently breaks new configs.
---

# Cloud Build fallback for CI and deploy

The governed release path is GitHub Actions. This skill is the fallback for when
Actions itself is unavailable — not a preference, and not a way around a red
build or a policy you would rather not satisfy.

## First: confirm this is actually the failure you have

Actions being *slow* and Actions being *broken* look identical from the deploy
workflow's error message, but only one of them justifies a fallback.

```bash
gh run list --limit 15
gh run list --workflow=main-post-merge-smoke.yml --limit 8
```

You are in a runner outage when runs sit in `queued` for far longer than their
historical duration while previous runs of the same workflow were green. A run
that reached `completed / failure` is a real test failure — fix the code.

The symptom that sends people here: `deploy-uat` or `deploy-production` fails at
**"Validate deployment SHA against main"**. That step is not testing your code.
It runs `scripts/ci/require-deploy-sha-on-main.sh` with `REQUIRE_CI_SUCCESS=1`
and `REQUIRED_CHECK_NAME="Main Post-Merge Smoke Gate"`, so a smoke run that is
merely *queued* fails the gate exactly like a red one. The deploy is blocked by a
missing verdict, not a bad one.

## Know which lanes you can actually reach

Check before planning anything, because the answer is not what IAM role listings
suggest:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["cloudbuild.builds.create","run.services.update"]}' \
  "https://cloudresourcemanager.googleapis.com/v1/projects/<PROJECT>:testIamPermissions"
```

| Lane | Project | Reachable from a laptop? |
|---|---|---|
| production | `hushh-pda` | Yes |
| dev | `hushh-pda-dev` | Yes |
| UAT | `hushh-pda-uat` | **No — by design** |

**UAT cannot be deployed by a human account.** `hushh-pda-uat` carries an IAM
*deny* policy, `uat-deploy-authority-lock`, that denies
`cloudbuild.builds.create` and `run.services.*` to everyone except the CI
deployer service account. Deny policies are invisible to `get-iam-policy`, so
`roles/run.admin` will appear granted while every real call returns 403. It is a
working control that forces UAT through the governed path. **Do not remove it,
do not grant yourself token-creator on the deployer service account, and do not
route around it with a Cloud Build trigger.** If UAT is the target, the honest
answer is to wait for runners and re-run `deploy-uat`.

## Get a verdict on the code: `deploy/ci.cloudbuild.yaml`

Runs the same checks as Actions by calling `scripts/ci/orchestrate.sh`, the
canonical stage entrypoint that CI itself uses, so the checks cannot drift.

```bash
gcloud builds submit --no-source \
  --project=hushh-pda-dev \
  --config=deploy/ci.cloudbuild.yaml \
  --substitutions=_SHA=<sha>,_STAGE=smoke
```

Stages: `smoke` (the release gate), `governance`, `web-core`, `protocol`,
`mcp-package`, `integration`, `secret`, `all`.

`--no-source` is deliberate. The repo's `.gcloudignore` excludes `.git/`, `*.sh`,
`*.md`, `docs/` and `tests/` because it is tuned for the Docker deploy builds —
a CI run against that upload would be missing every `scripts/ci/*.sh` and would
have no git history for `merge-base`. Step 0 therefore clones the repo (public,
no credentials) at `_SHA` with full history instead.

Not replicated, and deliberately not faked: `dco-check`, `pr-base-policy`,
`main-freshness-gate`, and the GitHub security-alert half of `secret-scan` all
read the pull-request event payload. `gitleaks` itself still runs.

### Making a green Cloud Build actually unblock a release

A green build that GitHub never hears about unblocks nothing — the deploy gate
polls GitHub for a check named exactly `Main Post-Merge Smoke Gate`. To close
that loop, publish a check-run back:

```bash
--substitutions=_SHA=<sha>,_STAGE=smoke,_PUBLISH_CHECK=true
```

This needs a token in Secret Manager named by `_GITHUB_TOKEN_SECRET` (default
`CI_FALLBACK_GITHUB_TOKEN`) with `checks:write`. Publishing a check-run that says
a gate passed is a claim about verification — only set `_PUBLISH_CHECK=true` when
the build genuinely ran the smoke stage green on that exact SHA.

## Deploy: `scripts/ops/cloudbuild_release.sh`

The two deploy cloudbuild configs were always Cloud Build. What lives only inside
Actions is the *orchestration*: scope resolution, secret sync, migrations,
no-traffic promotion, provenance and parity verification, and rollback. This
script reproduces that ordering with the same configs and the same substitutions.

```bash
# Always look first.
scripts/ops/cloudbuild_release.sh --env production --sha <sha> --dry-run

# Then, during a confirmed runner outage:
scripts/ops/cloudbuild_release.sh --env production --sha <sha> --skip-ci-check
```

Order of operations, matching the workflow: resolve and ancestry-check the SHA →
confirm deploy authority → capture predeploy revisions → resolve scope → sync
runtime secrets → migrate through the Cloud SQL proxy → build and deploy
`--no-traffic` → assert runtime identity → promote traffic → verify provenance,
parity, and HTTP health → roll back to the predeploy revision on failure.

`--skip-ci-check` waives only the *green check* requirement. It never waives the
ancestry check: a SHA that is not an ancestor of `origin/main` is refused
regardless, because shipping code that never landed on main is a worse failure
than shipping code whose CI could not be scheduled.

### Fallback releases are labelled as fallback

Revisions get `_DEPLOY_SOURCE=cloudbuild-fallback-<env>` rather than
`deploy-uat` / `deploy-production`, so a fallback release is visible in
`gcloud run revisions describe` and in provenance reports. Do not relabel it to
impersonate the governed lane — the label is how the next person knows which
releases bypassed Actions. Re-run the governed workflow once runners recover.

## The Cloud Build rule that will silently break a new config

Cloud Build resolves `$VAR` and `${VAR}` **before bash ever runs**. A name that
is neither a declared `_SUBSTITUTION` nor a built-in (`PROJECT_ID`, `BUILD_ID`,
`COMMIT_SHA`, …) fails the build — none of this repo's configs enable
`ALLOW_LOOSE`. So:

- **Shell locals must be lowercase**: `node_version`, `${config_arg[@]}`.
  Lowercase cannot collide with a substitution key (which must match `_[A-Z0-9_]+`)
  and is invisible to the substitution pass.
- **Real environment variables must be escaped `$$VAR`**: `$$PATH`,
  `$$GITHUB_TOKEN`. This is the only escaping form used in the repo.
- **Never write a bare uppercase `$VAR` / `${VAR}`** for a shell variable.

This is not theoretical — `${NODE_VERSION}` and `$PATH` in the first draft of
`deploy/ci.cloudbuild.yaml` would have failed the build immediately. Validate
before submitting; a build takes minutes to tell you, a parse takes seconds:

```bash
python3 -c "
import re,sys,yaml
B={'PROJECT_ID','PROJECT_NUMBER','BUILD_ID','LOCATION','COMMIT_SHA','SHORT_SHA',
   'REPO_NAME','BRANCH_NAME','TAG_NAME','REVISION_ID','TRIGGER_NAME'}
c=yaml.safe_load(open(sys.argv[1])); d=set(c.get('substitutions') or {})
t=re.compile(r'\\\$\\\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|\\\$\{?([A-Z_][A-Z0-9_]*)\}?')
bad=[(s.get('id'),m.group(0)) for s in c['steps'] for a in (s.get('args') or [])
     if isinstance(a,str) for m in t.finditer(a)
     if m.group(1) is None and m.group(2) not in B|d]
print(sorted(set(bad)) or 'PASS')" deploy/ci.cloudbuild.yaml
```

Also keep each step's inline bash under 10,000 characters — Cloud Build's cap on
a single step arg. `consent-protocol/tests/test_cloudbuild_step_arg_limit.py`
enforces it, and any new config must be added to its `CLOUDBUILD_CONFIGS` list.
Put explanatory comments *above* the step; prose inside `args` counts against
the cap.

## Repo facts worth not rediscovering

- `deploy/` and `scripts/ci/` are `protected_pipeline_paths` in
  `config/ci-governance.json`. Editing them requires the governance sections in
  the PR body or `verify-protected-pipeline-edits.py` fails.
- `scripts/ci/runtime-contract-check.sh` asserts invariants against
  `deploy/backend.cloudbuild.yaml` and `deploy/frontend.cloudbuild.yaml` **by
  filename**, so new configs with distinct names are safe.
- `resolve-deploy-scope.py --json` emits real JSON booleans. Reading them with
  Python's `print()` yields `True`/`False`, which never matches a lowercase
  `"true"` shell comparison — lowercase before comparing.
- Other agents share the primary checkout and may stash uncommitted work. Use a
  git worktree for anything non-trivial.

## Once runners recover

Re-run the governed workflow for the same SHA so the release carries governed
provenance, and confirm the serving revision's `HUSHH_DEPLOY_SOURCE` no longer
reads `cloudbuild-fallback-*`.
