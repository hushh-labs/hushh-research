# The goal-progress suite

Split out of `.codex/skills/puppy-one-harness/references/judging-contract.md`,
which owns the rules, the verdict writer, the void conditions, the controls and
the threat model. Everything there applies here; this file carries only what is
specific to `goal_progress`.

Structural validity was standing in for goal achievement, and the founder
called it: a valid action that does not advance the user's goal is still a miss.
The `goal_progress` suite grades that question, one action at a time, through
this same queue discipline. Its runner is the Hermes fork's
`hermes_cli/hussh_one_routing/exam/goal_progress.py`.

Rows are blinded across models: every model's actions go into one queue under
one seed with identity stripped, because the suite exists precisely because a
reputation disagreed with a number, and a judge who knows which rows are whose
is measuring the reputation. The identity map is stored beside the seal, and
handing it over defeats the blinding the way handing over the seal defeats the
tamper check. Each row shows the frontier run's next action labelled as one
known-good continuation and NOT ground truth: a different action can be
on-path, and the judge rules on progress, never on imitation.

### The five off-path rules

A `wrong` verdict in this suite may cite only these, each with a verbatim
citation:

- `wrong-object` — operates on an artifact the request never named. Cite it.
- `dead-end` — cannot yield what the request needs. Cite the argument that
  makes it one.
- `redundant` — repeats a step whose result is already in context. Cite the
  earlier result.
- `destructive-detour` — mutates state nothing asked to change. Cite the verb.
- `stalls` — asks the user or does nothing when the context already holds the
  answer. Cite the span that holds it.

`on_path` needs no citation. `unsure` counts against the model, as everywhere.

### Controls in this suite

Negative controls are real requests wearing another case's action: structurally
valid, off-path by construction, which is precisely what the cheap benchmark
cannot catch. One construction rule is load-bearing, learned from a voided run:
the donor action must not equal the base row's reference continuation, or the
control is on-path while labelled must-catch and voids any judge diligent
enough to notice. Positive controls are rows whose action equals the reference
byte for byte; flagging one voids the run.

### What this suite still does not prove

On-path is progress, not arrival. A true goal-achievement probe needs a
multi-turn rollout in a sandboxed worktree with a deterministic gate deciding
success; until that exists, goal progress is the honest ceiling of a
single-action judgement, reported beside structural and agreement as a third
number that is never added to either. The device's real daily jobs are graded under this same discipline; see `.codex/skills/puppy-one-harness/references/cron-quality-suite.md`.
