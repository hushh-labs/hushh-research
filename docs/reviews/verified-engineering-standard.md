# Verified Engineering Standard (work like Dean & Karpathy)

> **Staged for the wiki.** This is the source for the wiki page
> `wiki/concepts/verified-engineering-standard.md` (private, type: reference).
> The live wiki write is pending — the hushh-wiki connector was offline when
> this was authored. Publish it with `wiki_write` (or `wiki_capture`) when the
> connector is back; the frontmatter to use is at the bottom of this file.
> The always-on operational version already ships as the `verified-engineering`
> coding skill (`.claude/skills/verified-engineering/SKILL.md`).

**TL;DR:** Nothing is "done" until you have watched it work and can show the
evidence — reproduce before you fix, verify end-to-end, hunt your own
regression, grade honestly, and never fake a green.

---

Hushh engineers to the bar set by our role models — **Jeff Dean** (measure
first; a red build is stop-the-line; correctness proven, not asserted; systems
that scale) and **Andrej Karpathy** (the "test" step must actually run the
thing; understand the system end-to-end; simplicity; no hand-waving). This page
is the durable statement of that standard.

## The one rule

Nothing is "done" until you have **watched it work and can show the evidence.**
"Should work," "looks right," and "the logic is correct" are not done.
Reproduce, run, observe.

## Before changing code

- **Reproduce / measure first.** Reproduce a bug live before fixing it; measure
  before optimizing. You cannot fix what you have not observed.
- **Establish the baseline.** Know the test count and green-vs-red before you
  touch anything, so you can prove your change is what moved it.
- **Understand the system, not just the file.** Trace the full path and reuse
  the repo's own patterns instead of inventing parallel ones.
- **Focus.** One meaningful change at a time, done superbly. Sequence large
  work; breadth without depth is not shipping.

## The definition of done

A change is done only when all of these are true and the output is shown: the
relevant tests pass (with the count observed), typecheck and lint are clean on
the changed surface, the behavior was exercised end-to-end (the route, the tool,
the endpoint — not only a unit test), an adversarial self-review actively hunted
for the regression the change itself introduced, a regression test now pins the
behavior, a CI gate would catch it next time, and no generated artifacts
drifted.

## The anti-fabrication contract

- **Never fake success** — no stub that reports ready/green for an unbuilt path;
  no special-casing one demo or happy-path to look done; name scaffolds as
  scaffolds.
- **Never fabricate results or metrics** — if the number is unknown, mark it
  unknown and say so. A made-up green is worse than an honest red.
- **Never report a capability that was not verified** — "3 tests failed" beats
  "tests pass" every time.
- **Surface missing pieces explicitly** — return the explicit gap instead of a
  plausible fallback.

## Honesty in review

Grade against a rubric, show the grade progression across rounds, and never
inflate. Separate verified from plausible from needs-data. State the honest
ceiling: what reaching the top would take, and which part is a human/taste/owner
decision versus something that can be verified.

## Respect deliberate decisions

If a test or comment encodes an intentional choice you disagree with, do not
silently override it. Back out, surface the tension, and let the owner decide.
Disagreeing out loud beats a quiet override.

## The self-check before sending

Did I watch it work? Can I show the evidence? Did I try to break my own fix? Is
there a test and a gate so it cannot silently regress? Am I reporting exactly
what happened, including what failed or is still unknown? If any answer is no,
it is not done.

## Provenance

Distilled from a build cycle that lived it: a developer-platform security review
that reproduced a live credential-disclosure bug, fixed it, added a regression
test and CI, and re-verified 263 tests green; and a consumer-experience review
that found the product's consent moment specified but unwired, connected it, and
verified the change. Both are recorded in the engineering review notes in the
research repository (`docs/reviews/`).

## See also

- `AGENTS.md` — the repo engineering behavior contract (no hidden hardcoding, no
  fake production paths, LLM decisions stay with the LLM).
- `.claude/skills/verified-engineering/SKILL.md` — the always-on coding skill.
- `docs/reference/quality/definition-of-done.md` — the repo's shipped definition
  of done.

---

### Wiki frontmatter to publish with

```yaml
path: wiki/concepts/verified-engineering-standard.md
name: Verified Engineering Standard (work like Dean & Karpathy)
description: >-
  Hushh's durable engineering bar for all coding: measure/reproduce first,
  verify end-to-end and adversarially, grade honestly, never fake success or
  fabricate results, fix root cause plus a regression test plus a CI gate.
type: reference
visibility: private
status_as_of: 2026-07-28
relations:
  - "[Non-negotiables](../../non-negotiables.md) — constitutional operating rules this standard serves"
```
