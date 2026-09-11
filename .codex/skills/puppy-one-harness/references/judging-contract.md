# Judging contract for local model output

## The rules

Lifted from the shared PKM kernel the agent manifests actually carry, so the
judge holds a model to the instruction it was given, not to the judge's taste.

| Rule | Fails when |
| --- | --- |
| `right-domain` | Domain or `scope_path` does not match what the owner said |
| `no-invention` | A value appears that the utterance never contained |
| `durable-only` | A reminder, one-off task, secret, or operational request was saved |
| `no-metadata` | Parser version, hashes, trace ids, or internal paths written into user memory |
| `minimal-patch` | The patch carries more than the fact |
| `faithful-summary` | The summary does not describe what is being saved |

Grade only these; not style, not verbosity, not a choice you would have made
differently. Another suite declares another set, per *Improvised rules* below.

## Dates are a real failure mode

When the owner says "this fall" or "last year", check the resolved value against
the actual current date. Not pedantry: a model resolved "this fall" to
`fall 2024` on 2026-08-28, two years wrong, and that value was about to become
true in the owner's memory with nothing downstream to question it. The
structural benchmark scored that same output 100% valid.

## Verdicts

The grading lane is `sandbox_mode = "read-only"` and the fleet audit hard-fails
one that is not, so the grader does not write. It emits one JSON object per
row and the orchestrator replays the set through the same validated writer:

```
{"id":"<row id>","verdict":"correct|wrong|unsure","rule":"<rule>","citation":"<quote>"}

uv run python scripts/ops/memory_judge.py --run-dir <run dir> replay --from <grader jsonl>
```

An earlier version told the grader to run `record` itself while the same lane
was audited as read-only. Both cannot hold, and either resolution was silent:
a shell the audit said was absent, or an unfollowable instruction. Read-only is
the half kept, because a grader that cannot write also cannot edit the queue,
the manifest, the verdicts, the ledger, the scoring module, or a seal.

**What voids a run is a verdict line that did not pass the writer, not who
typed the command.** `replay` is `record` in a loop: every row still faces the
citation, rule, unknown-id and duplicate checks, and each accepted verdict
still puts one line in `verdicts.jsonl` and one in `verdict-writes.jsonl`. A
replayed run does not void; a line appended with a shell redirect still does.

Two costs, stated rather than buried:

- The grader loses the refusal at its own console. `replay` stops at the first
  refused row and names it, and the orchestrator hands it back. Replaying the
  corrected submission resumes rather than duplicating.
- The orchestrator could alter a verdict in transit. The mitigation is
  evidence: every submission is appended verbatim to `grader-submission.jsonl`
  before anything is written, so the recorded verdicts can be diffed against
  what the grader said. Changing an already-recorded verdict stays refused by
  the duplicate check.

- `verdict` is exactly `correct`, `wrong`, or `unsure`.
- A `wrong` verdict **requires** a citation quoting the offending value verbatim
  from that row's output. Ingest discards an uncited one as indistinguishable
  from a hallucinated one.
- If you cannot quote it, use `unsure`. It counts against accuracy, so it is not
  a way to dodge a call you could actually make.
- Grade every row. Ungraded rows void the run.

## Why the run can be void

A void run publishes **no accuracy at all**, never a number with a caveat: the
caveat is what gets dropped when the number is quoted.

| Cause | Meaning |
| --- | --- |
| A negative control passed | The grader is not reading. Nothing it said is worth having. |
| A positive control was flagged | The grader over-flags. Its failures are noise nobody can act on. |
| A row hash changed | The evidence was edited between issue and ingest. |
| Rows ungraded | A partial pass would let the grader skip what it found hard. |
| Verdicts discarded by a re-issue | The directory was issued again after it was graded. Re-issuing before grading is ordinary and scores; this is a second attempt. |
| Verdicts appended past `record` | The extra lines never passed the citation, rule and duplicate checks, and the write ledger says so. This is what returning verdict JSONL for someone else to write produces. |
| The attribution was edited | `suite`, `run_id`, `created_at` or `answerer_model` in the manifest is not the one the run was sealed with. The output of this harness is a number about a named model, so it is not published against an attribution the run was not issued under. |

## The controls

**Negative controls** — four planted outputs, each breaking a rule the agent's
instruction states in plain words, and deliberately **structurally valid**: a
control the cheap benchmark would catch proves nothing. Passing one voids the run.

**Positive controls** — two known-good outputs the judge must *not* flag.
Without them there is no false-positive rate: negative controls catch a
rubber-stamper and nothing else, so a judge told to hunt for plants could flag
every correct row and have its noise read as diligence. Flagging one voids the
run. They are deliberately plain, because a positive control a careful judge
could reasonably fault would punish good judgement.

Controls are shuffled by a seeded permutation and carry no marking. The seed is
**minted at issue** and sealed, so the permutation differs per run and is
reproducible from nothing the grader holds. Until 2026-09-10 it did not differ:
`--seed` defaulted to a constant, so every run an operator issued drew the same
permutation over the same corpus and one run seen was every later run named. An
explicit `--seed` is a declared **replay**; its report says
`blinding.positions_unpredictable: false` rather than claiming a blinding it
does not have. The seed is in neither `run-manifest.json` nor the operator's
receipt: replayed over the manifest's own row and control counts it names every
planted position exactly, with nothing but a Python interpreter.

**What an unpredictable shuffle does not buy.** The rows and the corpus are
literals in `memory_judge_controls`, identical in every run, so the threat
model's second and third read rows below stand whatever the seed is. Say before
grading if you have seen this corpus.

## Citing an omission

A citation is checked against the output **or the utterance**. Output-only
would silently penalise correct judgement: an omission failure has nothing to
quote in the output by definition, since the complaint is that it is absent.
Forcing those to `unsure`, which costs accuracy, would train a judge away from
the one failure class that loses the owner's records. So an omission cites the
utterance span that went unrecorded.

## The threat model: what the grading sandbox stops, and what it does not

The grading lane is `sandbox_mode = "read-only"` and `agent_fleet_audit.py`
hard-fails one that is not, so the grader emits verdicts, the orchestrator
replays them, and the grader cannot write. Everything below splits on that
line, because the reads were never what a sandbox was going to fix.

**Reads, which the sandbox does not stop, and nor does anything else here:**

| Do this | Which defeats |
| --- | --- |
| Read `run-manifest.json` | Nothing that locates a control today: it holds the rule vocabulary `record` enforces, the row count, how many rows are planted, and salted commitments. It held the shuffle **seed** until 2026-09-10, and that alone recomputed every planted position. `manifest_leaks_controls` voids a run whose manifest carries a field on `MANIFEST_FORBIDDEN_KEYS` (`seed`), and a test pins the whole key set |
| Read `memory_judge_controls` in `pod_lifecycle_drill.py` | The blinding, completely: the six planted rows are literals there, matchable against the queue with no manifest and no seal |
| **Grade this corpus a second time, or hear one run described** | The blinding, completely, and cheaper than every other row: it needs no command at all. The corpus and the planted rows are fixed literals, so knowing one run is knowing the true answer to every question and the wording of every plant. Minting the shuffle seed moved the positions and moved nothing else. The only fix is a corpus minted per run, which does not exist; the lane is told to declare prior exposure, and a declaration is not a control |
| `ls ../.judge-seals/*.seal.json` | The seal's concealment. Each seal names the run it was issued for, so listing the default directory identifies it without deriving the name. The drill's receipt reports which of the two cases a run had in `seal_location_derivable_from_receipt` |

**Writes, which the read-only lane cannot make and an operator still can:**
rewriting `review-queue.jsonl` or the manifest's `hashes`, appending to
`verdicts.jsonl` directly, revising a verdict already given, deleting both
verdict ledgers and re-issuing, or editing the scoring module. For the grading
lane these are now prevented rather than merely detected, which is the whole
reason the sandbox is the half worth keeping. For anyone holding a shell they
remain detectable and not preventable: the salted row hashes, the control and
rule commitments, the source hashes and the re-issue counter all live in the
seal, and any disagreement voids the run. Two stay only partly covered.
Deleting both ledgers before re-issuing erases the `reissued_after_verdicts`
void but not the trace, because the issue counter carries over from the run's
live seal and every report prints `ordinal: 2`; erasing that too takes a second
move against a seal `--judge-seal-dir` can put out of reach. And the source
hashes are checked by the source they cover.

### The seal

At issue time the harness seals these, into a file **outside the run directory**
whose name the grader is never given (see point 2 for what that is worth):

1. **Every row's content**, salted, so altered evidence is caught even when the
   in-run hashes were updated to match.
2. **Which rows are planted, and the rule each breaks**, in clear, plus the
   **shuffle seed and how it was drawn** (`seed_source`: minted at issue, or
   supplied for a replay): scoring cannot check a control it cannot read. The
   seed is minted per issue, so nothing outside the seal can predict where the
   controls landed; `seed_source` is sealed beside it so a replay cannot be
   relabelled as a blinded run. This is the answer key, protected by living
   outside the run directory and not by being hidden: see the seal-listing row
   above for what that is worth. The run directory keeps
   `controls_commitment` only.
3. **The harness source and the scoring module**, so a judge that rewrites the
   rules, controls or void logic invalidates the run instead of redefining it.
4. **The rule vocabulary and the issue counter**, so a widened rule list is
   caught and a re-issue after grading voids instead of getting a second attempt
   scored clean. The verdict chain is not sealed; it lives in `verdicts.jsonl`.
5. **The attribution** (`suite`, `run_id`, `created_at`, `answerer_model`),
   because the report publishes all four as fact and they live in the manifest,
   which the grader may read and can edit. Editing them breaks no row hash and
   no other commitment, so a forged set used to produce a clean report
   crediting a different model with the number. `identity_altered` voids a
   moved attribution, `identity_unsealed` one never committed to, and
   `identity_verified` is on every report.

A run with no seal is **void**, the loudest finding rather than the quietest:
tampering there is undetectable by construction. A seal inside the run
directory is also a violation, being one more file the judge can regenerate.

### Improvised rules

A `wrong` verdict may only cite a rule the run declares in `run-manifest.json`
(the six above here, another set for another suite); `record` rejects anything
else at write time. Inventing one produces a failure that looks fully compliant,
cited and well-formed, while grading against a standard nobody agreed to. An
unknown rule voids the run.

## What still cannot be enforced

Context separation. A session that wrote the queue remembers where it planted
the controls, and no script can ask "are you the same context", so it is a
discipline, stated in the report. When the same session does both, say so: the
control pass is a wiring proof, not a clean measurement. Verdicts on the
model's own output stay valid, because the grader did not author those. Nor is
the seal authentication: anyone who locates it and its salt forges a consistent
one, which raises the cost of an undetected edit without removing it.

## Comparing runs

The probe adapts to what a model supports, so two runs are comparable only when
their capability profile matches. One tested through tool calling and one
through JSON mode were not asked the same question, so a delta is invented
rather than measured; `compare_runs` refuses to produce it.

## The goal-progress suite

A second suite graded through this same queue discipline, with its own five
off-path rules and its own control construction:
`.codex/skills/puppy-one-harness/references/goal-progress-suite.md`. The
device's real daily jobs are graded the same way; see
`.codex/skills/puppy-one-harness/references/cron-quality-suite.md`.
