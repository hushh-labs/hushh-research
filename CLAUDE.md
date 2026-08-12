# CLAUDE.md — hushh-research (🤫 One / consent-protocol)

Durable context for **Claude Code** sessions in this repo. Read this first, then
`AGENTS.md` (the full operating contract), and route deeper work through the
**codex-bridge** skill (it reads `.codex/` at call time).

## What this repo is

The 🤫 hussh **One** product monorepo — the private agent backend, the One webapp, and
the **consent protocol (PCHP)** that powers them. (The marketing site lives in a
separate repo, `hushh-search-console`.)

- **Backend** — `consent-protocol/` — FastAPI + `uv` (Python **3.13**): the consent
  protocol / PCHP, Operons, HCT, Kai, IAM / PKM / vault, and the One APIs.
- **Frontend** — `hushh-webapp/` — Next.js (the One app).
- **Mobile** — native iOS shell; work happens on the `mobile` branch (see the
  `run-ios-sim` and `mobile-bug-log` skills).
- **Ops / CI** — `scripts/ci/` (governance + deploy gates), `scripts/ops/`
  (provisioning, secret sync, verifiers), `deploy/` (Cloud Build configs),
  `.github/workflows/` (deploy lanes).
- **Docs** — `docs/reference/**` (architecture + operations runbooks), `docs/future/**`.
- **Agent brain** — `.codex/` (skills / workflows / agents), surfaced via **codex-bridge**.

## Operating contract

- `AGENTS.md` (repo root) is the binding kernel: optimize correctness → security →
  reliability → maintainability → scalability → simplicity → performance; make the
  smallest high-quality change; verify claims against repo evidence; never expose
  secrets. Follow it.
- Human-facing prose: call One the **private agent**; prefer **information / records /
  holdings** over "data". Preserve exact code / API / route / schema / protocol
  identifiers verbatim.
- Consent-first, FedRAMP-High posture is always-on. Portfolio-wide brand, Apple-bar,
  and honesty directives live in the `hushh-search-console` `CLAUDE.md`.

## Local runtime (agent default — three in-session terminals)

There is **no** combined `stack` command. Run each as a background terminal and tail its
telemetry:

1. `./bin/hushh proxy   --mode local`            → port **6543**
2. `./bin/hushh backend --mode local --reload`   → port **8000**
3. `./bin/hushh web     --mode local`            → port **3000**

Health: `./bin/hushh doctor --mode local`, web origin `200`, backend `/docs`. Full
playbook: `.codex/skills/repo-operations/references/branch-runtime-ops.md`.

## GCP access IS present in-session — never re-derive this (founder directive, 2026-08-05)

**An operator service-account key with full access is already in the environment.** It is
`GCP_DEPLOY_SA_KEY_B64` (base64 SA JSON), alongside `GCP_DEPLOY_REF` and
`GCP_DEPLOY_REGION`. Assume it is there and use it. Do **not** conclude "no GCP access"
and do not ask the founder to supply it again — that question has been answered more than
once and re-asking it is the failure this section exists to stop.

- **`which gcloud` returns nothing, and that is irrelevant.** There is no `gcloud` CLI;
  access is via the **Cloud Run Admin v1 (knative) REST API** using this key. Concluding
  "no access" from a missing CLI is the exact wrong inference — it was made in this repo
  and cost a false "cannot deploy from here".
- **Never hand-roll the credential.** Use the repo's own loader,
  `hushh_mcp/services/gcp_run_client.py` → `load_operator_credentials()`; `GcpRunClient`
  creates / gets / deletes per-user Cloud Run services on top of it. Decoding the env var
  by hand is both unnecessary and (correctly) treated as credential extraction.
- **Read-only fleet check, the first thing to run:**
  `uv run python scripts/ops/pod_fleet.py --project hushh-pda-dev --region us-central1`
  from `consent-protocol/`. It lists every service labelled `app=hussh-one-pod` with
  whether it is genuinely serving.
- **Live dev project:** `hushh-pda-dev` / `us-central1`; pods run as
  `hussh-one-pod@hushh-pda-dev.iam.gserviceaccount.com`.
- **`Ready=True` is not proof a pod serves.** Cloud Run's default startup probe is a TCP
  connect and gunicorn binds its port before its workers boot, so a pod whose workers die
  on import reports Ready **and** ContainerHealthy while returning 503 to everything
  (observed in `hushh-pda-dev`, 2026-08-04). Check `probe=http /health`.
- **Dev is a shared, costed environment.** Live pods left running cost money — check the
  fleet before creating more, and tear down what a session created.

Searching for this key by the names you *expect* (`GOOGLE_*`, `GCLOUD_*`) misses it; the
name is `GCP_*`. Search the space of plausible names, not the guess.

## Deploy lanes (GitHub Actions, `workflow_dispatch`)

| Lane | Workflow | GCP project | Promotes? | How it's triggered |
|---|---|---|---|---|
| dev | `deploy-dev.yml` | `hushh-pda-dev` | no (shared integration) | dispatch, any CI-green ref |
| uat | `deploy-uat.yml` | uat | stricter, `main`-only | dispatch, founder sign-off |
| production | `deploy-production.yml` | prod | terminal, `main`-only | dispatch, founder sign-off |

For every lane the **workflow definition runs from `main`**, while the **content
deployed is `inputs.ref` / `inputs.sha`**. A deploy requires (a) a **governed actor**
(`scripts/ci/assert-governed-actor.py --surface <lane>`) and (b) a SHA that is reachable
from the ref **and** carries a green `CI Status Gate` (or `Queue Validation` /
`Main Post-Merge Smoke Gate`).

### Dev fast lane — preview a feature branch

To see an unstable feature branch (e.g. a `claude/…` branch) running end-to-end, deploy
it to **dev** (`deploy-dev.yml` → `hushh-pda-dev`). Dev accepts **any CI-green ref** and
**never promotes** to uat/prod. The backend reports `ENVIRONMENT=dev` (2026-08-07); the
frontend still reports `uat`. See `consent-protocol/docs/reference/dev-environment-setup.md`
§ *Identity Model* for what that changed and what it deliberately did not.

- It is a **shared** integration environment — a dispatch replaces whatever was last
  deployed there, so coordinate with the team before stomping it.
- **Playbook:** `docs/reference/operations/dev-fast-lane.md`.

## Conventions

- **Branch:** develop on `claude/hushh-infrastructure-analysis-7o991c` for this
  workstream. Never push to `main` or deploy uat/production without founder sign-off.
- **Commits to `main`** must be human-authored + DCO **`Signed-off-by`** and pass the
  attribution gate (no AI byline). `main`'s `protected_pipeline_paths`
  (`.github/workflows/`, `deploy/`, `scripts/ci/`, `config/ci-governance.json`) are
  edit-restricted to the maintainer cohort.
- **Nothing pushed to GitHub names the assistant — standing rule (founder directive,
  2026-08-04).** Commit messages and trailers, PR titles and bodies, issue and review
  comments carry **no** AI byline, no "Generated by" footer, no assistant name, and no
  `claude.ai` session link. Work is attributed to the human who signed it off. Author
  identity stays the active GitHub account's own address
  (`40542375+kushaltrivedi5@users.noreply.github.com`), per the
  `github-contribution-governance` skill — never an assistant address, which would both
  break this rule and cost the contribution credit.
  - *Not covered by this:* real repository paths and filenames (`.claude/skills/`,
    `CLAUDE.md`) when a change genuinely touches them. Those are the subject of the work,
    not a byline. Prefer a neutral commit scope (`docs(agents):` over `docs(claude):`) so
    the distinction never has to be argued.
  - The cost of the no-byline rule is that commits show as **Unverified** on GitHub,
    because a verified signature would require a different committer identity. That is a
    deliberate trade, not an oversight — do not "fix" it by re-authoring commits.
  - History that is already pushed is **not** rewritten to satisfy this; per
    `github-contribution-governance`, pushed history changes need explicit branch-level
    approval. Fix what is editable (PR bodies, comments) and leave the rest.
- **CI:** every PR runs the `CI Status Gate`; verify locally before pushing.
- **DCO signoff is mandatory on every commit, and it is enforced in three places
  (founder directive, 2026-08-11).** Nothing here asks you to remember anything:

  1. **`scripts/ci/orchestrate.sh` activates the tracked hooks** on first run in a
     clone (`core.hooksPath` → `.githooks`), and is a deliberate no-op in CI. It lives
     there because it is the standing pre-push gate — the one thing that reliably runs.
  2. **`.githooks/pre-push` refuses to push an unsigned commit**, scoped to what is new
     in the push. Override for a single push with `HUSSH_ALLOW_UNSIGNED_PUSH=1`.
  3. **`dco-check` in `.github/workflows/ci.yml`** is the backstop, and feeds both
     `Preflight Gate` and `CI Status Gate`.

  `.githooks/prepare-commit-msg` is tracked and appends `Signed-off-by` when a message
  lacks one. `core.hooksPath` is **per-clone local config** — git will not set it from a
  checked-in file, by design. That was the whole gap: the hook existed, was correct, and
  had never run, and **78 of 167 non-merge commits reached the remote unsigned**. The
  `CI Status Gate` went red, every test lane was *skipped* rather than run, and the dev
  deploy refused the SHA — with the fix sitting tracked in the tree the entire time.
  - `git commit -s` also works and is what to use when the hook is not on yet.
  - **Why the automation, rather than a fifth instruction:** four remedies already
    existed — `scripts/setup-hooks.sh`, `consent-protocol/ops/monorepo/setup.sh`,
    `./bin/hushh protocol setup`, and a `verify_setup` that prints a red cross for it.
    All four were correct. All four needed a human to remember them. None ever ran.
    A remedy that depends on memory is the same defect as an agent that is deployed and
    never called; fix the wiring, not the documentation.
  - Clearing an unsigned backlog means rewriting pushed history, which needs explicit
    branch-level approval per `github-contribution-governance`. Signing as you go is
    the only cheap moment; afterwards it is never cheap again.
  - Guard: `consent-protocol/tests/test_dco_signoff_is_unmissable.py` — nine tests that
    **run** the hook, the gate's activation, the DCO decision against a real unsigned
    commit, and the pre-push refusal plus its override.
- **Engineering bar:** the `verify-before-claim` skill is the standing practice for all
  coding work here — verify against the running artifact rather than memory, reproduce a
  gate locally at the CI-pinned version before pushing, read the real code before
  designing, ship dark, and never suppress a control or fabricate an attestation.
- **Secrets:** never in code — GCP Secret Manager / env only.
- **Docs cadence:** update the relevant `docs/reference/**` runbook with any infra
  change (founder-brief + changelog cadence per `.codex/skills/docs-governance`).

## Attribution + response signature — PERMANENT, NON-NEGOTIABLE (founder directive, 2026-07-28)

**Name every skill, agent, and component at the moment you use it, and close each
response with a signature listing only what was actually used or evolved.** This is a
compulsion, not a suggestion, and it does not expire when a session is compacted or a
context window rolls over. If you are reading this file, the rule is in force.

Two halves, both required:

1. **On the fly.** When you invoke a lane, say so inline as you invoke it — "applying
   `verify-before-claim`…", "routing through **codex-bridge**…", "dispatching the
   `security_consent_auditor` agent…". Routing must be visible while it happens, not
   reconstructed afterwards.
2. **At sign-off.** End the response with a short block naming **only the lanes actually
   leveraged or changed in that response**, and what each was used for.

**Never dump the full inventory.** A signature that lists every available lane carries no
information — it reads identically whether a lane was used or not, which is the same
failure mode as a status code that says `200` on an empty page. Attribution is only
meaningful when it is selective. If a response used nothing, say so or omit the block.

Format — **one lane per line, as a bullet.** Never run several lanes together on one line
separated by `·`; that packs the most useful information in the response into the least
readable shape, and at three or four lanes it stops being scannable at all (founder
directive, 2026-08-04).

```
---
**Subagents used:**
- `repo_operator` — deploy-lane evidence
- `Explore` ×2 — ADK surface, audit scope

**Skills used:**
- `verify-before-claim` — live-artifact verification of the deployed revision

**Skills evolved:**
- `verify-before-claim` — added the fallback-classification lesson
```

Each bullet is `lane — what it was actually used for`. Keep the "what for" concrete: the
value of the block is that a reader can tell what each lane *did*, not merely that it ran.

Omit a heading entirely when that category is empty — an empty heading is noise. If a
response used nothing, say so plainly or omit the block.

Evolve the lanes as you use them: when a session teaches a durable lesson, fold it into
the relevant skill or agent definition in the same change, grounded in real repository
findings and the north stars. Per `AGENTS.md`, lanes **inherit the kernel by pointer** —
cite `AGENTS.md` rather than copying its doctrine into a skill prompt.

## Branch synchronization — PERMANENT ENGINEERING RULE (founder directive, 2026-08-12)

**Fetching `main` is not permission to overwrite this branch.** DEV is deliberately ahead
of `main`: it carries the modular per-person pod deployment and represents the transition
to the future architecture. `main` still carries the older shape. Git resolves text and has
no opinion about which side is the architecture, so a merge resolved by recency can undo
the direction of the work and leave a clean commit and a green diff behind.

Measured 2026-08-12 in `deploy/backend.cloudbuild.yaml`: `_BUILD_POD_IMAGE` branch=5
main=**0**; `Dockerfile.pod` branch=3 main=**0**; `consent-protocol-pod` branch=4 main=**0**.
`main` does not build the per-user pod image at all. Taking its side of that one file
deletes modular pod deployment, after which provisioning, the relay and the turn all
address an image nobody publishes.

**The procedure, every time:**

1. **Assess before resolving.** `git merge-tree` first. Distinguish paths that genuinely
   conflict from those that merely need a three-way merge — on the 2026-08-12 sync only
   **10 of 19** truly conflicted, and the other 9 needed a semantic read, not a decision.
2. **Resolve by architectural intent, never by recency.** For each conflict ask which side
   carries the future architecture. Keep this branch's side on pod-deployment surfaces and
   port genuinely new `main` content on top of it.
3. **Never hand-merge generated artifacts.** Regenerate them, in dependency order, with the
   topology index last because it digests the others. A hand-picked hash makes the artifact
   lie about what it digests.
4. **Watch for semantic conflicts git will not flag** — a `.gitignore` that merges cleanly
   while contradicting a mirror the other side committed is the known example.
5. **Verify the resulting codebase after every merge**, not just that it builds. Run
   `consent-protocol/tests/test_pod_architecture_is_authoritative.py`, the generator
   `--check` modes, and the affected suites.
6. **Merge on a scratch integration branch**, never directly on the workstream branch.
7. **UAT and PROD stay isolated** until the transition is explicitly approved. Preview on
   the **dev** lane only.

**The guard:** `consent-protocol/tests/test_pod_architecture_is_authoritative.py` asserts the
architectural direction — pod image build, relay mount, turn router, the pod-conditional
memory guard, the specialist authority gate, carried grounding, and migration 141's
idempotency guard appearing exactly once. It goes red and names what was lost, which is the
only moment the loss is cheap to undo. It is registered in `scripts/test-ci.manifest.txt`.

**Commit identity is the GitHub-connected account, always.** Author and committer stay
`40542375+kushaltrivedi5@users.noreply.github.com` per `github-contribution-governance` —
never a generic, proxy, or assistant address, which would misattribute the work and cost the
contribution credit. Tooling that suggests re-authoring commits to a proxy identity is to be
declined; the resulting **Unverified** badge is a deliberate trade, documented above, not a
defect to fix.

## Where to look

- **Private Agent architecture — the single source of truth, inherited by pointer and
  never restated** → `docs/reference/architecture/private-agent-north-star.md`. Where an
  implementation diverges from it, the implementation moves.
- Operating kernel → `AGENTS.md`
- Route any task → **codex-bridge** skill (reads `.codex/` live)
- **The bypass lane** (who may land directly on `main` and edit protected pipeline paths,
  and what it never waives) → `docs/reference/operations/branch-governance.md` §*The bypass
  lane*. Live membership is `config/ci-governance.json` only — never transcribed into prose.
- Who I am to GitHub → repo-local **and** global git identity are the active MCP account
  (`kushaltrivedi5`); see the `github-contribution-governance` skill
- Preview a branch → dev fast lane: `docs/reference/operations/dev-fast-lane.md`
- iOS / mobile → `run-ios-sim`, `mobile-bug-log` skills
- How we work (Dean / Karpathy method, verification discipline) → `verify-before-claim` skill
- Canonical skill center (platform-neutral skills + the bridge contract) → `skills/README.md`
  and `AGENTS.md` § *Canonical skill center*
- Returning after time away → `context-refresh` skill
