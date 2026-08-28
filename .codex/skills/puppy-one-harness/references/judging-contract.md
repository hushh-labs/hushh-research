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
| A planted control passed | The grader is not reading. Nothing it said is worth having. |
| A row hash changed | The evidence was edited between issue and ingest. |
| Rows ungraded | A partial pass would let the grader skip what it found hard. |

## The controls

Four planted outputs, each breaking a rule the agent's instruction states in
plain words. They are deliberately **structurally valid** — a control the cheap
benchmark would catch proves nothing about the judge.

They are shuffled by a seeded permutation, differ in position per run, carry no
marking, and their answers live only in `run-manifest.json`, which the grader
must not open.

## What cannot be enforced

Context separation. A session that wrote the queue remembers where it planted the
controls, and no script can ask "are you the same context". So it is recorded as
a discipline and stated in the report.

When the same session does both, say so: the control pass is a wiring proof, not
a clean measurement. Verdicts on the model's own output are still valid, because
the grader did not author those.

## Comparing runs

The probe adapts to what a model supports, so two runs are comparable only when
their capability profile matches. A model tested through tool calling and one
tested through JSON mode were not asked the same question, and a delta between
them is invented rather than measured. `compare_runs` refuses rather than
producing a trend nobody can invalidate.
