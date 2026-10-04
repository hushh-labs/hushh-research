# PKM Structure Agent Live Eval


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This benchmark is temporary evaluation infrastructure for the PKM structure path.

It inherits the methodological rules in `./pkm-agent-north-star.md`.

## Purpose

- harden the PKM structure agent using live Gemini calls only
- keep preview-only behavior
- prevent vague fallback domains from masking weak classification
- measure whether smaller models stay inside the same structured contract

## Contract

The preview path is an ADK/A2A-style pipeline:

1. `Memory Segmentation Agent`
   - returns exact quotes, `context_quotes`, and `not_memory` for every line it does not select

2. `Memory Intent Agent`
   - returns `IntentFrame`
   - decides durable vs ephemeral vs ambiguous, and a live `command` versus memory
   - classifies ontology intent
   - decides mutation intent
   - returns broad candidate domains

3. `PKM Structure Agent`
   - returns `PKMStructurePreview`
   - chooses the target domain
   - emits candidate payload
   - emits structure decision and scope plan

Deterministic validation runs after the model and can downgrade output to `confirm_first` or `do_not_save`.

## Ontology

The intent ontology is fixed:

- `preference`
- `profile_fact`
- `routine`
- `task_or_reminder`
- `plan_or_goal`
- `relationship`
- `health`
- `travel`
- `shopping_need`
- `financial_event`
- `command`
- `correction`
- `deletion`
- `note`
- `ambiguous`

## No `general` Policy

`general` is not a valid success-state domain for benchmark scoring.

- if the model proposes `general`, validation downgrades it to an unresolved decision
- unresolved decisions must become `confirm_first`
- confirmation choices must use broad top-level domains from the domain registry

## Phase Ladder

- `fresh_random_120`
  - `120` all-new single-turn prompts
  - no exact reuse of the earlier sanity strings
- `fresh_chain_60`
  - `60` chained prompts for one evolving PKM
- `fresh_chain_120`
  - `120` chained prompts for one richer evolving PKM
- `context_transfer`
  - `12` sections of a pasted context transfer, sent the way the device sends them (heading
    plus lines): tech stack, a GCP project id, an environment variable name, an OAuth callback,
    people, vendors, repository metrics, AI tools, agent architecture, a salary, a finance
    preference, and one live command. Every statement must stay durable and land in a work
    domain (or Finance for the preference); only the command is ephemeral. Production
    2026-09-29 dropped exactly this shape as "not about the owner" or "opaque".

- `context_transfer_document`
  - the synthetic, founder-shaped context transfer the web save-job tests replay
    (`hushh-webapp/__tests__/fixtures/pkm/context-transfer.v1.md`; every name and
    number in it is synthetic). Each section is sent the way the device sends it;
    a `split_recommended` answer is discarded and the passage halved. Graded
    **line by line**, not by card count: a memory line is kept only when a
    write-eligible card's quote maps onto it (`locate_source_quote`), a line under
    "Information not known" must never be saved, and a word-for-word repeat may
    go either way. Gates: mean line coverage `>= 0.95`, zero disclaimers saved,
    fallback `<= 0.10`, and the variance gate below. `lost_lines` names every line
    lost and in how many repetitions.

## Honest harness

The judging rules of `.codex/skills/puppy-one-harness/references/judging-contract.md`
apply here (`consent-protocol/scripts/pkm_eval_integrity.py`):

- **The judge is never the answerer.** Gemini answers; a pure scorer
  (`_score_case`, `score_passage`) grades against labels authored in the corpus.
- **Planted controls, unmarked.** Every repetition plants four negative controls
  (wrong domain on a confirm_first card, wrong intent, wrong mutation, and a
  fallback that guessed the right label) and two positive controls. They reach the
  scorer through the same function as real rows, at seeded random positions; the
  answer key stays with the harness. The document phase plants a dropped line, a
  paraphrased quote, a saved disclaimer, and two clean passages.
- **A void run publishes no accuracy.** A negative control graded clean or a
  positive control flagged voids the run: every rate is withheld (null), the gate
  fails, and the ledger records `status: void`.
- **`unsure` counts against accuracy.** A field produced by a stage that fell back
  to a non-model answer is graded wrong even when the fallback guessed the label.
- **Domain is graded on every write mode.** The retired rule graded any
  confirm_first card domain-correct; the production path files every durable
  write as confirm_first, so the domain rate read 1.0 by construction. The
  `wrong_domain_confirm_first` control voids a scorer that regresses to it.
- **The chain grows the way an owner reviews.** A confirm_first card enters the
  simulated state like a can_save card, carrying its entity id, and each request
  sends the active entities newest first. Counting only can_save meant the
  production path never grew a state, so every "extend" was graded against an
  empty PKM.
- **Variance is measured.** `--reps N` replays the chain from a blank state N
  times and reports, per gated rate, the mean, min, max, spread (max minus min)
  and sample standard deviation. `--enforce-gates` fails a run of fewer than three
  repetitions (`variance_unmeasured`) and any gated rate whose spread exceeds
  `--max-rate-spread` (default `0.10`, two release-chain cases).
- **Production path by default.** The release gate used to run the strict
  small-model prompt path, which `/api/pkm` never takes. It now runs the production
  path; `--strict-small-model` opts into the other, and the choice is recorded.
- **Capability profile.** Every report and ledger entry records, per agent, the
  model id and the effective thinking level, plus the runtime adapter, the prompt
  path and the SDK versions. The instructions under test are recorded separately
  as the `subject` (per-agent instruction sha256), because they are what a
  comparison is meant to vary.
- **Append-only ledger.** `--ledger consent-protocol/artifacts/pkm-structure-agent/ledger.v1.jsonl`
  appends one hash-chained entry per run (void runs included) under a file lock.
  `tests/scripts/test_eval_pkm_structure_agent.py::test_committed_ledger_chain_is_intact`
  fails if an entry is rewritten. `--compare BEFORE_SEQ AFTER_SEQ` prints mean and
  spread deltas and refuses entries of different phases, a void entry, or
  different capability profiles.

- **Stage diagnostics, never graded.** The eval reads each stage's raw answer at
  `_run_agent_contract`, the one method every memory stage goes through in both
  the baseline and the head. It reports `durable_drop_stage_counts` (which stage
  dropped each durable statement that was not saved: intent, merge, structure,
  or a deterministic service rule) and `payload_authored_by_model_rate`.

```bash
python3 scripts/eval_pkm_structure_agent.py --phase release_chain_24 --skip-shadow \
  --model gemini-3.6-flash --reps 3 --enforce-gates \
  --ledger artifacts/pkm-structure-agent/ledger.v1.jsonl
```

### Measuring a baseline

Grade the old instructions with the new judge: extract the old commit with
`git archive <sha> consent-protocol hushh-webapp/__tests__/fixtures/pkm` into a
scratch directory (no worktree, no `node_modules`), copy the three harness files
(`consent-protocol/scripts/eval_pkm_structure_agent.py`, `consent-protocol/scripts/pkm_eval_integrity.py`,
`consent-protocol/scripts/pkm_eval_document.py`) over it, and run it with this checkout's
`.venv/bin/python` and `--source-ref <sha>`, which the ledger records because an
archive is not a git checkout. Confirm the archive imports its own
`hushh_mcp` first; the corpus lives in the eval script, so both sides answer the
same cases.

## Results: old instructions against new (2026-10-03)

Gemini 3.6 Flash, `low` thinking on every memory agent, production prompt path,
`direct_client` adapter (the regional Vertex client; the ADK single-turn path
was not exercised), google-genai 2.23.0, google-adk 2.9.0. Every entry n=3,
every planted control graded correctly (12/12 negative and 6/6 positive per
synthetic run, 9/9 and 6/6 for the document), zero provider refusals. Old is
`c7b319179` graded by the new judge (`--source-ref`); new is `1ab1f7c6e`.
Ledger sequence numbers in brackets; `--compare` accepts every pair below.

| Rate (mean ± spread) | Release chain old [2] | Release chain new [8] | Context transfer old [3] / [11] | Context transfer new [6] / [9] / [10] |
|---|---|---|---|---|
| schema | 0.958 ± 0.000 | 1.000 ± 0.000 | 1.000 / 1.000 | 1.000 / 1.000 / 0.972 ± 0.083 |
| intent | 0.750 ± 0.083 | 0.917 ± 0.000 | 0.861 ± 0.083 / 0.917 | 0.917 / 0.917 / 0.889 ± 0.083 |
| mutation | 0.736 ± 0.042 | 0.917 ± 0.000 | 1.000 / 0.972 ± 0.083 | 1.000 / 0.972 ± 0.083 / 0.917 ± 0.250 |
| domain | 0.958 ± 0.000 | 0.986 ± 0.042 | 1.000 / 0.944 ± 0.167 | 1.000 / 0.889 ± 0.250 / 0.889 ± 0.333 |
| durable coverage | 0.697 ± 0.091 | 0.985 ± 0.045 | 1.000 / 0.939 ± 0.182 | 1.000 / 0.879 ± 0.273 / 0.849 ± 0.455 |
| fallback | 0.000 | 0.000 | 0.000 / 0.056 ± 0.167 | 0.000 / 0.111 ± 0.250 / 0.139 ± 0.417 |
| gate | fail | **pass** | fail / fail | **pass** / fail / fail |

Document (line by line, 151 memory lines): old [4] line coverage 0.993 ± 0.013,
fallback 0.026 ± 0.077; new [7] 1.000 ± 0.000, fallback 0.000. No disclaimer
saved by either. Both pass.

Reading it:

- The release chain moves from failing four gates to passing all of them. The
  durable statements it lost were dropped by merge (8), intent (7), and service
  rules (5) on the old instructions; on the new, by merge once.
- Context transfer is at parity on answered cases. The failures in [9], [10]
  and old [11] are provider latency: one repetition each hit the 45 s preview
  budget (inner timeouts 4, 5, and 2), graded as fallbacks, while the other
  repetitions were perfect. Old and new time out in the same window. A timeout
  is not voided, because latency is a property of the subject; it is why the
  spread gate fails.
- `payload_authored_by_model_rate` is 0.0 for old and new: see
  [the prompt contract](./pkm-prompt-contract.md#the-saved-payload-is-not-model-authored).
- Remaining label disagreements, reported rather than retuned: `ct_finance_pref`
  expects `preference` while five corpus cases label a money preference
  `financial_event`; release case 035 expects `plan_or_goal`/`extend` with no
  earlier travel plan in the chain; case 012 expects `extend` for a second
  cuisine preference the agents treat as a new subject.

Provenance notes, kept because the ledger is append-only:

- [0] and [1] are an earlier old-head run from a deleted scratch checkout; [5]
  is the new head before `1ab1f7c6e` (coverage 0.939, fail).
- [5] to [7] recorded the tree state at the end of each run while other lanes
  committed; none of those commits touched a file the eval imports. [7] lists
  two service files as dirty because they were edited after that process had
  imported the code. Since `1ab1f7c6e` the state is recorded at run start.

## Live Model Policy

Current live eval mode:

- model: the fleet text model (`gemini-3.6-flash` for the 2026-10-02 measurements),
  recorded per agent in the capability profile
- posture: each manifest's authored thinking level (`low`) on the production prompt path
- Vertex endpoint: validate model availability in the configured project and region before promotion; no unavailable model may be retained as a fallback-only default.

Promotion discipline:

- keep the classifier on the lowest-latency posture first
- do not hide weak prompt behavior behind heavier reasoning modes

The benchmark always calls live models. It may cache only:

- domain registry snapshot
- synthetic persona state
- shadow baseline reconstruction
- prompt corpus and scoring config

It must not cache prior model outputs across runs.

The benchmark should recommend the current single-model minimal posture only if it stays inside the acceptance gates.

## Reviewer Shadow Policy

Daily structure-agent checks should include the env-wired reviewer fixture:

```bash
python3 scripts/eval_pkm_structure_agent.py --phase fresh_chain_60 --env-file .env
```

When `REVIEWER_UID` is present, it is the first shadow user. Legacy reviewer ids are fallback only.

For protocol or prompt hardening that is expected to pass acceptance criteria, add `--enforce-gates`. The script fails nonzero when schema, domain, durable-domain coverage, mutation, intent, fallback, finance-contamination, or unresolved-domain gates regress.

Shadow replay is still read-only and must not send decrypted PKM values to the model. It reconstructs the domain/scope surface from manifests and scope registry metadata, then runs natural prompt chains against that shape. If the reviewer fixture is missing expected domains, repair or reseed that reviewer account rather than switching to another UID.

Before a PKM protocol-version bump, also run:

```bash
python3 scripts/audit_active_pkm_shape_readonly.py --env-file .env
```

If reviewer secrets are not present in the local maintainer env, add `--gcp-secret-project hushh-pda-uat`; the script reads `REVIEWER_UID` and `REVIEWER_VAULT_PASSPHRASE` from Secret Manager into process memory only. That audit decrypts active reviewer `pkm_blobs` locally in memory and emits only redacted structure, counts, and presentation painpoints. It is the reviewer-backed evidence lane for noisy key-value structures, duplicate branches, oversized arrays, and consumer-presentation drift.

## KPI Definitions

- `save_class_ok_rate`
- `intent_ok_rate`
- `mutation_ok_rate`
- `domain_ok_rate`
- `confirmation_ok_rate`
- `fallback_rate`
- `finance_contamination_count`
- `unresolved_domain_count`
- `durable_domain_coverage_rate`
- `drift_flag_counts`
- `average_latency_ms`
- `p95_latency_ms`
- `timeout_count`

`durable_domain_coverage_rate` is the share of expected durable cases that resolve to one of that case's allowed domains with a write-eligible durable result. Each case is counted once, so an allowed alternative domain cannot manufacture a false under-coverage failure. The minimum gate is `0.95`.

## Promotion Gates

Move from `fresh_random_120` to deeper runs only when:

- schema validity is stable
- `general` no longer appears as a success-state domain
- finance prompts resolve to the governed financial lane or sanctioned financial memory
- corrections and deletions stop over-confirming
- fallback rate stays at or near zero
