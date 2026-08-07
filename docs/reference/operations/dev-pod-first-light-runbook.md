# Dev pod first light — the human actions, in order

**Dated 2026-08-07.** Everything code-side for task #110 is landed and pushed. What remains
is two human actions and a check: confirm CI is green, dispatch the dev deploy, and a browser
session with a real AI key. (Setting a dev OTP was removed; the code is optional in the
simulation lane, see step 3.)

Read this top to bottom before starting. Step 1 is the one most likely to be skipped, and
skipping it makes step 2 fail.

## Visual Map

```mermaid
flowchart TB
  A["1 · Confirm CI Status Gate<br/>is green on the head SHA"] -->|"CI Status Gate green<br/>on the exact SHA"| B
  B["2 · Deploy to Dev<br/>FROM main, ref = the branch"] -->|"creates personal_agent_registry<br/>promotes traffic itself"| C
  C["3 · Nothing — the OTP is<br/>optional in the dev lane"] --> D
  D["4 · Browser: claim +15550100,<br/>connect a REAL AI key"] --> E{"Pod created?"}
  E -->|"pod_fleet.py"| F["First light"]
```

## Before you start

| | |
|---|---|
| Branch | `claude/hushh-infrastructure-analysis-7o991c` |
| Head SHA | **take it from the PR** — see the note below |
| PR | [#4675](https://github.com/hushh-labs/hushh-research/pull/4675) (`[dev-ci][do-not-merge]`) |
| Target | `hushh-pda-dev` / `us-central1`, service `consent-protocol` |
| Front end | `https://dev.one.hushh.ai` |

You must be in the **`dev` surface** of the governed-actor cohort (`config/ci-governance.json`)
for step 2. Dev is a **shared, costed** environment — a dispatch replaces whatever was last
deployed there, so tell the team before you start.

**Do not trust a SHA written in a document, including this one.** This page deliberately
does not pin one: the commit that added it changed the head, which is exactly how a pinned
SHA goes stale. Take the current head from PR #4675 (or `git rev-parse origin/claude/hushh-infrastructure-analysis-7o991c`)
and use that *same* value in steps 1 and 2. The two must match — the deploy gate checks the
SHA, not the branch.

---

## Step 1 — Confirm CI is green on the branch head

**This step used to say CI never runs automatically here, and gave a reason that turned
out to be wrong.** The claim was that GitHub does not raise `pull_request: synchronize`
for app-token pushes. It does — `pull_request` runs fire on this branch. What was actually
true is narrower: CI had not run for a stretch, and when it did run it was **failing**, so
the head carried no green gate either way.

`ci.yml` now also triggers on pushes to `claude/**`, so a push produces a run without
anyone dispatching one. Both the push and pull_request runs appear.

1. Open PR [#4675](https://github.com/hushh-labs/hushh-research/pull/4675) and look at the
   head commit's checks.
2. If **`CI Status Gate`** is green, go to step 2.
3. If it is red, read the first FAILING job, not the gate. The gate is a summary: when
   `Governance` fails, `Preflight Gate` fails, every test lane skips, and the gate reports
   failure over a suite that never ran. The real message is in the earlier job.
4. Only if no run exists at all: Actions → **PR Validation** → **Run workflow** → branch
   `claude/hushh-infrastructure-analysis-7o991c`, `scope: all`.

## Step 2 — Deploy to Dev, dispatched **from `main`**

**The trap.** The workflow *definition* always runs from `main`; the *content* deployed is
the ref you pass. An earlier attempt dispatched this from the branch and died in one second
at *Assert manual dispatch originates from main*.

1. GitHub → **Actions** → **Deploy to Dev** → **Run workflow**
2. **Use workflow from: `main`** ← the whole step turns on this
3. `scope`: `auto`
4. `ref`: `claude/hushh-infrastructure-analysis-7o991c`
5. `sha`: the SHA you confirmed green in step 1

Paste the SHA rather than leaving it blank. Blank means "head of ref at dispatch time"; if
anything lands on the branch between steps 1 and 2 you would deploy a SHA CI never saw, and
the gate would reject it.

**What this does that matters:** `db/migrate.py` runs from the *deployed SHA*, and
migrations `900`/`905` exist only on this branch — so this dispatch is what finally creates
`personal_agent_registry` in dev. It also rebuilds the pod image
(`_BUILD_POD_IMAGE` defaults true) and **promotes traffic itself**, so there is no manual
traffic step. The revision runs with `ENVIRONMENT=uat` for behaviour parity and
`_DEPLOY_ENV=dev` for lane identity; that split is deliberate and is what the simulation
guard reads.

**Watch:** the *Post-deploy dev schema contract gate* step. It is the one that would notice
if the new migrations did not land.

**Confirm before moving on:**

```
SELECT migration_id, status FROM schema_migrations WHERE migration_id LIKE '90%';
```

Both `900` and `905` must be present. `905` adds the columns the liveness sweep reads.

## Step 3 — Nothing. The OTP is optional in dev.

**This step used to exist and no longer does.** It required a `gcloud run services update`
after *every* dev deploy, because the deploy uses `--set-env-vars` and replaces the whole
environment — a step that would be forgotten, and whose absence looks exactly like a broken
lane.

In the simulation lane, no code configured means no code checked. Any code is accepted at
the confirm step. That relaxation is bounded on three sides, all of which must hold at once:

- `simulation_permitted()` — an explicit opt-in **and** a deploy lane naming a development
  environment. `uat`, `staging` and `production` are refused outright.
- the allowlist — only reserved fictitious numbers can be claimed at all.
- the challenge — the confirm call must still follow a start call for the same number.

**If you ever need to rehearse the real OTP flow in dev**, set `HUSHH_DEV_PHONE_TEST_CODE`
and the code check turns back on with no other change:

```bash
gcloud run services update consent-protocol \
  --region=us-central1 --project=hushh-pda-dev \
  --update-env-vars=HUSHH_DEV_PHONE_TEST_CODE=<a 6-digit code>
```

Separately, the **client-side phone mandate** is bypassed on `dev.one.hushh.ai` exactly as
it is on `localhost`, so a dev user is never routed to the phone screen. That is a routing
mandate only — it grants no verified phone, and the AI-connection gate still reads
`phone_verified is True` server-side before it will provision anything.

## Step 4 — Drive it from the browser

1. Sign in at `https://dev.one.hushh.ai` with a test account.
2. Verify a phone using one of the pinned simulation numbers — **`+15550100`** through
   **`+15550104`**. Any code is accepted unless `HUSHH_DEV_PHONE_TEST_CODE` is set.
3. **Connect an AI key.** This one cannot be faked: the gate validates the key against the
   provider, and provisioning is triggered by the AI connection, not by the phone step.

The phone is still read **server-side** from the verified identity and never from a request
body — the bypass replaces the SMS round trip, not the control.

## Confirming first light

```bash
# from consent-protocol/
uv run python scripts/ops/pod_fleet.py --project hushh-pda-dev --region us-central1
```

A pod appears labelled `app=hussh-one-pod`. **`Ready=True` is not proof it serves** — Cloud
Run's default startup probe is a TCP connect and gunicorn binds its port before its workers
boot, so a pod whose workers die on import reports Ready and still 503s everything. Look for
**`probe=http /health`**.

Then ask the agent a question in the app. A streamed answer is the thing nobody has seen
yet, in any environment, for anyone.

## If something refuses

| Symptom | Cause | Fix |
|---|---|---|
| Deploy fails at *Validate deployment SHA* | No green `CI Status Gate` on that SHA | Step 1, then re-dispatch with the same SHA |
| Deploy dies in ~1 second | Dispatched from the branch | Re-dispatch with **Use workflow from: `main`** |
| Deploy fails at *Assert manual dev dispatch actor policy* | Account not in the `dev` surface | Governed-actor cohort in `config/ci-governance.json` |
| Phone step says not allowlisted | A number outside the pinned five, or the simulation lane is off | Use `+15550100`–`+15550104`; confirm the revision carries `HUSHH_DEV_SIMULATION_ENABLED` |
| Provisioning never starts | No AI key connected | The AI connection is the trigger, not the phone |
| `SimulationNotPermittedError` in the logs | `HUSHH_DEV_SIMULATION_ENABLED` missing | It ships in the dev block of `backend-deploy.sh`; confirm the revision is from this branch |
| Pod is Ready but 503s | Workers died on import | Read the pod's own logs; Ready means the port is bound, nothing more |

## Tear down what this creates

Dev is costed and live pods bill continuously. Check the fleet when you are done and remove
what the session created; the reap sweep is not attached and would not do it for you.

## Sources

- `.github/workflows/deploy-dev.yml` and `ci.yml`, `scripts/deploy/backend-deploy.sh`, `deploy/backend.cloudbuild.yaml`, read 2026-08-07.
- Live GitHub reads: PR #4675 head check runs (zero), the last 30 `PR Validation` runs on this branch (all `workflow_dispatch`), and repo-wide run activity confirming Actions is healthy, 2026-08-07.
- Companion records: [the dev fast lane](./dev-fast-lane.md) and [the north star](../architecture/private-agent-north-star.md).
