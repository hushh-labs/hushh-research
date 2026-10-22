# Drive packet batch evaluation (`hushh_eval.drive_packets`)

Measures whether Drive packets are right, on synthetic fixtures (CI) or on one
consenting owner's real Drive (operator, read-only). It is never imported by the
runtime (`hushh_mcp`, `api`) and is excluded from the runtime image.

```
python -m hushh_eval.drive_packets plan-batch | run-batch | judge | label | score | report | gate
```

| Command | What it does |
| --- | --- |
| `plan-batch` | Builds (or reuses) the sampling frame and preregisters a seeded two-stage cluster sample. Writes `plan.json` with `plan_sha256`. |
| `run-batch` | Refuses a changed plan or a changed runtime SHA, then replays the production code (`DrivePacketWorker` facts and packet phases, in memory) on each sampled file. Resumable by case id. |
| `judge` | Deterministic checks first (a failure is final). Then J1 (pinned Pro-tier model) and J2 (a different model), temperature 0, seed 20261015, typed schema, exact quotes. Disagreement is `unknown` and goes to the human queue. |
| `label` | Deterministic labels (page count, content hash, period phrases), blind pre-labels (pages and file metadata only), silver agreement, family partition (30% held out), the human slice. `--interactive` first asks a person pass / fail (with severity) for each queued Ready packet, wrong ones first, then undecided, then passed; a person's verdict overrides the model judges. It then runs the y/n/edit field labeler. |
| `score` | The nine stage metrics with exact one-sided 95% bounds. |
| `report` | Founder report (12 lines or fewer, every number `x of n`, always with the 59 and 2,995 bars) and `report.public.json` (allowlisted counts only). |
| `gate` | `--gate deploy|listing|ready`; exit 0 pass, 1 fail, 2 insufficient evidence. |

## CI

`tests/eval_drive_packets/` runs on the synthetic `tests/fixtures/drive_pipeline_eval`
corpus with `FakeInterpret` and `FakeJudge` through the runtime's `interpret=`
injection point: no network, no Vertex, no private data. The guard regression
suite (`tests/fixtures/drive_packet_eval/adversarial/`) feeds adversarial model
outputs to the runtime validators; an unexpected Ready-with-defect turns CI red.
Cases with `known_gap` are tracked runtime work and run as strict expected failures
(when the runtime closes a gap, its case passes and the strict marker fails CI until
`known_gap` is removed from the generator). No gaps are open today: the runtime
refuses one original selected twice and an undated or wrongly dated Ready
month, and closes a packet whose sources name different accounts. The runtime
also closes a Ready packet whose account record names someone other than the
owner's name on file (`tests/services/test_drive_packet_owner_guard.py`).
`run-batch` hands that name to the replay, from the live owner's identity on file
or `--owner-name`, in memory only: it never enters a prompt, a batch file or a
report, and the run prints only where it came from (`owner_check`). Fixture runs
and this suite pass none, so they do not exercise that fence. The runtime also
refuses a Ready period dated only by a due, print, transaction, event or snapshot
date its facts give the same line, refuses Ready copy claiming complete coverage
of months no dated period covers, and closes a Ready packet holding two originals
of one statement (same issuer, type, account and period, own document date or,
for undated files, creation day).

## Operator runbook (real Drive, read-only)

1. Worktree, venv, caches and outputs live on the SSD. The workdir must be outside
   every git worktree with mode 0700, for example
   `/Volumes/AnkitSSD/DevCache/drive-eval-private/<batch>`. Originals stay there
   only; delete non-held-out originals after scoring.
2. Run a local Cloud SQL proxy for `hushh-pda-uat:us-central1:hushh-uat-pg` (or
   reuse a running one) and pass its port with `--db-port`. The eval opens one
   connection (`pool_size=1`, `max_overflow=0`) with
   `default_transaction_read_only=on` and `statement_timeout=20000`, and checks
   `transaction_read_only` before every query.
3. Secrets are read with `gcloud secrets versions access` into process memory.
   Drive access is GET-only (`files.list`, `files.get`, export). The stored OAuth
   token is used while fresh; otherwise it is refreshed in memory and never written.
4. Model calls use the UAT GenAI project with your own ADC (`unset
   GOOGLE_APPLICATION_CREDENTIALS` if it points to a key without Vertex access),
   `ENVIRONMENT=local`, `GENAI_GOOGLE_CLOUD_PROJECT=hushh-vertex-personal54`,
   `GOOGLE_CLOUD_LOCATION=global`, `HUSSH_GEMINI_TEXT_MODEL=gemini-3.6-flash`.
   Concurrency is at most 8 for Vertex and 4 for Drive; a 429 rate above 2%
   pauses the batch; `--max-cost-usd` is a hard cap.
5. Never create a Cloud Run job, dispatch a workflow, or write to UAT.

```
export DRIVE_PACKET_EVAL_LIVE=1 DRIVE_PACKET_EVAL_OWNER=<consenting owner user id>
W=/Volumes/AnkitSSD/DevCache/drive-eval-private
python -m hushh_eval.drive_packets plan-batch --workdir $W --batch-id B001 --source uat \
  --db-port 6655 --seed 20261015 --anchors $W/anchors.json
python -m hushh_eval.drive_packets run-batch  --workdir $W --batch-id B001 --max-cost-usd 60
python -m hushh_eval.drive_packets judge      --workdir $W --batch-id B001
python -m hushh_eval.drive_packets label      --workdir $W --batch-id B001
python -m hushh_eval.drive_packets score      --workdir $W --batch-id B001
python -m hushh_eval.drive_packets report     --workdir $W --batch-id B001
python -m hushh_eval.drive_packets gate       --workdir $W --batch-id B001 --gate listing
```

## What a result means

- The independent unit for packet gates is the family; at most one Ready packet
  per family counts, and a family with any wrong Ready packet counts as wrong. With
  zero failures, the one-sided 95% bound needs 59 independent Ready packets for 95%
  and 2,995 for 99.9%. One owner's Drive cannot establish 99.9%.
- Until a person has decided every counted Ready packet (`label --interactive`),
  every number is model-judged and the listing gate stays `insufficient`.
- Replay measures the checked-out SHA, not what UAT serves. Reports name the mode
  and SHA. Packets in replay are formed among the sampled files only.
- Local extraction has no OCR engine on macOS; pages UAT already extracted are
  read from UAT (production output), others are extracted locally from the
  original and marked `local`.
- Price checks compare against an eval-owned rubric (`config/price-rubric.v1.json`),
  not market value. Token costs are estimates from bytes for the runtime path.
