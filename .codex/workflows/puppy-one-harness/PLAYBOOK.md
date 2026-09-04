# Puppy One Harness Playbook

## Goal

Measure an on-device model honestly. Two questions, never conflated: the
benchmark asks *well-formed and fast*, the judge asks *correct*.

The gap between them is the whole point. A model can emit a perfectly shaped
`save_to_pkm` call that files a dietary restriction under `finance.accounts`,
and the shape check passes it. On this repo's own ladder, the **fastest** model
scored 100% on throughput and produced **zero** usable saves.

## Steps

1. Collect outputs by running the model over the corpus.
2. Write a review queue. Controls are planted, shuffled per run, unmarked.
3. Grade in a session that did **not** write the queue.
4. Ingest. The run voids if a control passed, a row hash changed, or any row
   went ungraded.
5. Append to the ledger, including the capability profile.
6. Turn every confirmed failure into a fixture.

## The rules that keep a number honest

- **The judge is never the answerer.** Same model on both sides refuses to run.
- **Every `wrong` verdict cites**, and the citation is checked against the
  output. An uncited failure is indistinguishable from a hallucinated one.
- **A void run publishes no accuracy at all.** Not a number with a caveat — a
  number with a caveat gets quoted without the caveat.
- **`unsure` counts against accuracy.** Otherwise hedging is free.
- **Runs with different capability profiles are not compared.** A model tested
  through tool calling and one tested through JSON mode were not asked the same
  question.

## Adding a model

Do not assume it can tool-call. Probe what it supports and adapt the shape, then
record the capability profile in the ledger row. Scoring a capable model 0
because the probe assumed something it does not do is a harness bug reported as
a model result.

## Common Drift Risks

1. grading in the session that wrote the queue
2. opening `run-manifest.json` while grading
3. reporting accuracy for a run whose controls were missed
4. comparing runs with different capability profiles
5. treating structural validity as correctness
