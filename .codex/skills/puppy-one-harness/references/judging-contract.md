# Judging contract for local model output

## The rules

Lifted from the shared PKM kernel the agent manifests actually carry, so the
judge holds a model to the instruction it was given rather than to the judge's
own taste.

| Rule | Fails when |
| --- | --- |
| `right-domain` | Domain or `scope_path` does not match what the owner said |
| `no-invention` | A value appears that the utterance never contained |
| `durable-only` | A reminder, one-off task, secret, or operational request was saved |
| `no-metadata` | Parser version, hashes, trace ids, or internal paths written into user memory |
| `minimal-patch` | The patch carries more than the fact |
| `faithful-summary` | The summary does not describe what is being saved |

Grade only these. Not style, not verbosity, not a choice you would have made
differently.

## Dates are a real failure mode

When the owner says "this fall" or "last year", check the resolved value against
the actual current date. This is not pedantry: a model resolved "this fall" to
`fall 2024` on 2026-08-28, two years wrong, and that value was about to become
true in the owner's memory with nothing downstream to question it. The structural
benchmark scored that same output 100% valid.

## Verdicts

One JSON object per row in `verdicts.jsonl`:

```json
{"id": "c004", "verdict": "wrong", "rule": "no-invention",
 "citation": "fall 2024", "note": "one sentence"}
```

- `verdict` is exactly `correct`, `wrong`, or `unsure`.
- A `wrong` verdict **requires** a citation quoting the offending value verbatim
  from that row's output. Ingest checks it and discards the verdict if the string
  is not there, because an uncited failure is indistinguishable from a
  hallucinated one.
- If you cannot quote it, use `unsure`. It counts against accuracy, so it is not
  a way to dodge a call you could actually make.
- Grade every row. Ungraded rows void the run.

## Why the run can be void

A void run publishes **no accuracy at all** — not a number with a caveat, because
a number with a caveat gets quoted without the caveat.

| Cause | Meaning |
| --- | --- |
| A negative control passed | The grader is not reading. Nothing it said is worth having. |
| A positive control was flagged | The grader over-flags. Its failures are noise nobody can act on. |
| A row hash changed | The evidence was edited between issue and ingest. |
| Rows ungraded | A partial pass would let the grader skip what it found hard. |

## The controls

**Negative controls** — four planted outputs, each breaking a rule the agent's
instruction states in plain words. Deliberately **structurally valid**: a control
the cheap benchmark would catch proves nothing about the judge. Passing one
voids the run.

**Positive controls** — two known-good outputs the judge must *not* flag.
Without them the design has no false-positive rate at all: negative controls
catch a rubber-stamper and nothing else, so a judge told to hunt for planted
failures could flag every correct row, sail through, and have its noise read as
diligence. Flagging one voids the run.

They are deliberately plain. A positive control a careful judge could reasonably
fault would punish good judgement, which is the opposite of the point.

All controls are shuffled by a seeded permutation, differ in position per run,
carry no marking, and their answers live only in `run-manifest.json`, which the
grader must not open.

## Citing an omission

A citation is checked against the output **or the utterance**. Output-only would
be a bug that silently penalises correct judgement: an omission failure — the
model dropped a fact the owner stated — has nothing to quote in the output by
definition, since the complaint is that it is absent.

Forcing those to `unsure`, which counts against accuracy, would train a judge
away from reporting the one failure class that loses the owner's data. So an
omission cites the utterance span that went unrecorded.

## The threat model: the judge has god-mode

The judge lane holds `Bash`. Say this plainly rather than in a footnote, because
every other control in this harness is enforced by code the judge can edit.

A judge with a shell can:

| Do this | Which defeats |
| --- | --- |
| Read `run-manifest.json` | The hidden controls — it names them |
| Rewrite `review-queue.jsonl` | The evidence it is graded on |
| Rewrite the manifest's `hashes` | The in-queue tamper check |
| Append to `verdicts.jsonl` directly | The validating writer |
| Revise a verdict it already gave | Its own record |
| Edit `judge.py` | The rules, the controls, the void logic |

**None of that is preventable at this layer.** Prevention needs a sandbox where
the judge cannot write to the harness or the seal — a separate user, container
or machine. That is an infrastructure change, not a code change.

What IS available is making every one of those **detectable**, and voiding the
run when one is found. That is the difference between "the judge can cheat
invisibly" and "the judge can cheat and the result is discarded".

### The seal

At issue time the harness seals four things, into a file that lives **outside
the run directory** and whose path the grader is never given:

1. **Every row's content**, salted, so altered evidence is caught even when the
   in-run hashes were updated to match.
2. **A commitment to which rows are planted** — a salted hash, not a list, so
   the seal is not itself the answer key it protects.
3. **The harness source**, so a judge that rewrites the rules invalidates the
   run instead of redefining it.
4. **A hash chain over verdicts**, so revising an earlier verdict breaks every
   one after it.

A run with no seal is **void**, and that is the loudest finding rather than the
quietest: an unsealed run is one where tampering is undetectable by construction.

A seal found inside the run directory is also a violation. Inside, it is one more
file the judge can regenerate, and mistaking it for protection is worse than
having none.

### Improvised rules

A `wrong` verdict may only cite one of the six defined rules. Inventing one
produces a failure that looks fully compliant — cited, well-formed — while
grading against a standard nobody agreed to. An unknown rule voids the run.

## What still cannot be enforced

Context separation. A session that wrote the queue remembers where it planted the
controls, and no script can ask "are you the same context". So it is recorded as
a discipline and stated in the report.

When the same session does both, say so: the control pass is a wiring proof, not
a clean measurement. Verdicts on the model's own output are still valid, because
the grader did not author those.

And the seal is not authentication. A judge that locates the seal file and its
salt can forge a consistent one. This raises the cost of an undetected edit from
zero to "find and rewrite a second file you were never told about"; it does not
make it impossible.

## Comparing runs

The probe adapts to what a model supports, so two runs are comparable only when
their capability profile matches. A model tested through tool calling and one
tested through JSON mode were not asked the same question, and a delta between
them is invented rather than measured. `compare_runs` refuses rather than
producing a trend nobody can invalidate.
