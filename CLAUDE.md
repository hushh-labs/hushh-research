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
it to **dev** (`deploy-dev.yml` → `hushh-pda-dev`). Dev accepts **any CI-green ref**, keeps
the `uat` runtime identity for behavior parity, and **never promotes** to uat/prod.

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
- **CI:** every PR runs the `CI Status Gate`; verify locally before pushing.
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

Format:

```
---
**Used:** `verify-before-claim` (live-artifact verification) · `repo_operator` (deploy-lane evidence)
**Evolved:** `verify-before-claim` — added the fallback-classification lesson
```

Evolve the lanes as you use them: when a session teaches a durable lesson, fold it into
the relevant skill or agent definition in the same change, grounded in real repository
findings and the north stars. Per `AGENTS.md`, lanes **inherit the kernel by pointer** —
cite `AGENTS.md` rather than copying its doctrine into a skill prompt.

## Where to look

- Operating kernel → `AGENTS.md`
- Route any task → **codex-bridge** skill (reads `.codex/` live)
- Preview a branch → dev fast lane: `docs/reference/operations/dev-fast-lane.md`
- iOS / mobile → `run-ios-sim`, `mobile-bug-log` skills
- How we work (Dean / Karpathy method, verification discipline) → `verify-before-claim` skill
