# AGENTS.md alignment audit

**Status as of 2026-08-03.** A complete audit of the repository against its own operating
kernel, `AGENTS.md`, asking one question: does the system actually do what the kernel says?

Re-run at any time — this is on-demand by design, not a CI gate:

```bash
python3 scripts/ops/audit_agents_md_alignment.py
python3 scripts/ops/audit_agents_md_alignment.py --json    # machine-readable
python3 scripts/ops/audit_agents_md_alignment.py --strict  # non-zero exit on failures
```

## Visual Context

Canonical visual owner: [operations index](../operations/README.md).

## The headline

**Of 13 kernel sections, exactly one is mechanically enforced. Seven are partial. Five are
asserted only.**

That is the finding. `AGENTS.md` is overwhelmingly a document of intent, held up by judgment
rather than by checks. Nothing is wrong with judgment — some doctrines cannot be linted — but
it explains how the Agent Architecture Doctrine could contradict the architecture of record
for eight days without a single check failing. Doctrine that nothing verifies will drift, and
the drift is silent by construction.

## Two live risks

### R1 — `docs-parity-check.sh` does not run in CI at all

`scripts/ci/orchestrate.sh` defines an `advisory` stage containing `docs-parity-check.sh`,
`subtree-sync-check.sh`, `github-security-alerts.sh`, `verify-production-environment-governance.sh`,
and `codex audit`. **No workflow invokes that stage.** `ci.yml` and `queue-validation.yml`
call `secret`, `governance`, `web-*`, `protocol`, `mcp-package`, and `integration` only.

Eight checks are therefore dead in CI, including doc governance, brand verification, link
integrity, and visual coverage. Every one of them works — they were run manually throughout
the July personal-agent workstream and repeatedly caught real defects (a broken visual-owner
link, unresolved path references, a markdown link resolving from the wrong base). They simply
never run when nobody remembers to run them.

**This is the single most consequential finding in the audit.** Detected automatically by
checks C5 and C6.

### R2 — the Commit Attribution HARD RULE has no mechanical control

`AGENTS.md` marks it a HARD RULE. No CI check scans commit messages for
`Co-Authored-By: Claude` or "Generated with Claude Code". The entire control is the
`includeCoAuthoredBy: false` flag in `.claude/settings.json` — currently correct, and nothing
verifies it stays that way or catches a commit authored outside this configuration.

## Enforcement map

| Kernel section | Verdict | Basis |
|---|---|---|
| Read this first / anti-drift | asserted | No check compares kernel claims to architecture docs |
| Principal Craft Kernel | partial | Anti-duplication half only; secrets covered by gitleaks separately |
| Bacterial Architecture Gate | partial | Marker presence string-checked; `architecture_fitness.py` measures violations but **exits 0 by design** |
| Runtime Telemetry Default | asserted | None |
| Agent Architecture Doctrine | asserted | Nine principles, none gated — this is the section that drifted |
| Premise Verification Gate | partial | `truth_first_smoke.py` runs only via `one-mac.yml`, path-gated on `apps/one-mac/**` |
| **Canonical skill center** | **mechanical** | `sync_claude_agents.py --check` verifies mirrors byte-for-byte; `skill_lint.py` validates manifests |
| Routing Gate | partial | Router smoke proves resolution, not that an agent routed |
| Delegation Checkpoint | partial | Lane count, thread and depth bounds enforced; behaviour is not |
| Authority Boundary | partial | Deploy authority enforced; the 12 handoff tokens only by a script that effectively does not run |
| BYOK Reviewer Browser Gate | asserted | `reviewer-app-testing-check.sh` exists but no gate invokes it |
| Branch Discipline (HARD RULE) | asserted | Self-declared "enforced by judgment" |
| Commit Attribution (HARD RULE) | partial | See R2 |

## Live structural checks

Computed from the tree on every run, so they cannot go stale the way this table can.

| Check | Result |
|---|---|
| C1 — platform bridges point at canonical, never restate | PASS |
| C2 — canonical skill frontmatter matches its directory | PASS |
| C3 — every generated agent mirror traces to an authored `.toml` | PASS — 12 lanes, 12 mirrors |
| C4 — commit-attribution control present | PASS (flag correct; see R2 for why that is thin) |
| C5 — every `orchestrate.sh` stage reachable from CI | **RISK** — `advisory` never invoked |
| C6 — `docs-parity-check.sh` reachable from CI | **RISK** — not invoked by any workflow |

C1 closed a gap in the canonical skill center itself: when it was introduced, nothing
verified that a bridge body actually pointed at `skills/<name>/SKILL.md` rather than
restating the skill. The check now enforces both the pointer and a size ceiling, since a
bridge that grows into a copy is the exact failure the centre exists to prevent.

## What is genuinely strong

Worth stating plainly, because an audit that only lists faults misleads:

- The **canonical skill and subagent centres** are the best-governed part of the kernel.
  Agent mirrors are verified byte-for-byte; skills carry validated manifests.
- **Zero-knowledge is enforced in code, not asserted.** Public-keys-only pod keypair parsing,
  a DB `CHECK` forbidding legacy export keys, dropped plaintext tables, ciphertext-only PKM
  writes, PII log sanitisation, and an owner-gated receipted pod read path.
- **Deploy authority** is genuinely gated by `assert-governed-actor.py`, and the dev, UAT and
  production lanes each refused an unauthorised action during the July workstream.

## Recommended remediation, in priority order

1. **Invoke the `advisory` stage in CI**, or move `docs-parity-check.sh` into the governance
   stage. Eight working checks currently protect nothing. This is a one-line workflow change
   in a `protected_pipeline_paths` file, so it needs a maintainer.
2. **Add a commit-message scan** for the attribution HARD RULE, or state honestly in the
   kernel that it is judgment-enforced. A rule labelled HARD with no control is a claim the
   system cannot keep.
3. **Decide whether `architecture_fitness.py` should ever fail.** Measuring violations and
   always exiting 0 means the Bacterial Gate is advisory in practice while reading as
   mandatory in the kernel.
4. **Ungate `truth_first_smoke.py`** from `apps/one-mac/**` so the Premise Verification Gate
   applies to normal work.

## Sources

- Kernel under audit: `AGENTS.md`
- Audit tool: `scripts/ops/audit_agents_md_alignment.py`
- Standing verification practice: `skills/verify-before-claim/SKILL.md`
