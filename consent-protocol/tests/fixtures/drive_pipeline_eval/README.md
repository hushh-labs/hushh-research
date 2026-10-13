# Original document regression corpus v1

Six synthetic original PDFs back five request cases. `doc-005.pdf` contains a
scanned image with no PDF text layer. The remaining originals include a wrong
year, wrong issuer, incidental mention and prompt injection. No customer file or
credential is included. Gold labels come from fixture construction before model
execution, and are never sent to the pipeline adapter.

The two development requests share one account/family. Three held-out cases have
different families and originals. These are synthetic regression partitions,
not an independent production sample. Do not convert a perfect result into a
99.9% reliability claim. Real evaluation requires an authorized private corpus,
independently adjudicated original-page labels, and a documented sampling plan.

The three original held-out cases were inspected during the October 13 runtime
fixes. Their partition labels are retained for reproducibility, but all later
runs are development regressions. A new untouched, representative holdout is
required for a confirmatory quality claim.

## Adapter and report

Run `scripts/eval_drive_pipeline.py --output /private/report.json` for extraction
only. The default extractor uses the actual original bytes; semantic results stay
unobserved. A real pipeline adapter is an explicit `--adapter module:callable`
with `DRIVE_PIPELINE_EVAL_LIVE=1`. It receives the request, original bytes, immutable
hashes, and extraction pages, never gold facts, selections, or pricing ranges.
No adapter may grant Drive access or charge a buyer as a testing shortcut.

Reference coverage is exact content periods, not file creation/modification dates.
Structured observation fields and the adapter signature live in the runner's
module documentation. `document_decisions` uses `include`, `exclude`, `unknown`;
`document_facts` uses reference fact names such as issuer and period_start.
`coverage` is `{status, periods: [[start, end]], gaps: []}` with ISO dates.
Gaps contain established missing-period intervals, not narrative explanations.
Unknown coverage asserts neither a covered interval nor a missing interval;
its explanation is a separate limitation. The verifier accepts readiness, so
correct abstention agrees with an independently labeled unverifiable packet.
An adapter must normalize host-validated output into this observation contract;
unknown/unobserved fields must stay absent. Provider model version, prompt/schema,
code and extraction versions identify the actual evaluated runtime.

## Independent checks

Workstream 10 measures the runtime verifier's decision against external original
document labels; the verifier and model confidence never supply their own gold.
Coverage, classification, facts, false readiness and missing/failed attempts have
separate denominators. Delivery is measured only with an observed receipt source;
an isolated fake-provider receipt must be described as simulated.

Workstream 12 compares suggested prices with a versioned product rubric:
`drive-packet-price-v1`. The comparable same-account, same-quality pair expects
the larger useful period scope not to cost less. The reference ranges are broad
fixture-author judgments ($0.50–$15 for one verified period, $1–$30 for two),
not market valuations or evidence of calibrated pricing accuracy. Owner editing
and exact approved price remain production contracts outside this scorer.

## Confidence and continuous evaluation

The reusable metric leaf computes one-sided 95% exact binomial lower bounds.
With zero failures, `0.05 ** (1 / n) >= 0.999` first holds at **2,995 independent
representative trials**. Each packet is one trial; retries, paraphrases and files
inside that packet are correlated. A 95% two-sided lower bound needs 3,688 perfect
independent trials. The target is not currently established.

Use fixed, preregistered sample sizes for release decisions. A rolling dashboard
must not repeatedly peek at ordinary fixed-sample intervals and stop on success.
Independent production holdout, separate selected-document sampling, runtime
provenance and all-attempt outcomes are explicit gates. Costs/tokens unknown to
the adapter stay null. Pricing receives no 99.9% claim.

Primary references: [NIST exact binomial intervals](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm),
[NIST representative evaluation and ongoing measurement](https://airc.nist.gov/airmf-resources/airmf/3-sec-characteristics/),
[time-uniform confidence sequences](https://arxiv.org/abs/1810.08240).

## Development expansion v2

`manifest-v2.json` preserves all v1 cases and original bytes unchanged, including
the same three held-out cases. It adds four development requests backed by seven
new original PDFs. `generate_dev_v2.py` fixes their input facts and gold before
model execution. It uses deterministic ReportLab output; ReportLab is only a
fixture-generation dependency.

- Hinglish plus explicit September 1 to October 9, 2026 dates, generic filenames,
  and a same-owner wrong-account distractor.
- Missing October coverage, despite a September statement, another account's
  statement and a 2017 statement with a recent Drive modification timestamp.
- Final original versus an explicitly labeled duplicate copy and an overlapping
  interim activity report. The request explicitly prefers the original; the gold
  does not arbitrarily break a tie between indistinguishable copies.
- A misleading filename and instructions inside meeting notes, alongside wrong
  account and wrong content-period distractors.

Gold covered periods are the original statement intervals. A request ending
October 9 may use an October monthly statement; its actual content period stays
October 1–31. Missing coverage is labeled as exact ISO date intervals. Optional
`source_metadata` is retrieval context, never evidence of a statement period.
The model adapter must receive that context explicitly for a metadata-resistance
claim. Merely extracting these PDFs does not prove semantic selection quality.
