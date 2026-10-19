# The cron quality suite: the daily jobs are the exam

Added 2026-09-02. The owner measures the on-device model by whether its real
scheduled jobs work, not by exam numbers. So the jobs are graded directly, in
the Hermes fork (`hermes puppy jobs collect` and `hermes puppy jobs report`),
under the same discipline as every other suite in the judging contract:
blinded queue, closed rule set, planted controls, and a run that voids rather
than publishing a number with a caveat.

## Two halves, never summed

**Deterministic contract checks**, read off each job's own prompt:

- the exact branded header, or the `[SILENT]` token when the prompt allows
  silence;
- required lines (the wiki job must print "Commits in the last 36h:" and
  "Wiki scan:");
- required tool calls (the wiki job must really call `wiki_search` or
  `wiki_list`) and forbidden ones (the Auto-Dream model half touches no
  files);
- a write counts only when its tool result reports success;
- the artifact a job promises exists on disk (the previous month's
  timesheet);
- no leaked tracebacks, and phone-length brevity.

**A blinded judge pass** with a closed rule set. A `wrong` verdict may cite
only one of: `format-contract`, `no-work`, `contradicts-evidence`,
`wrong-recipient`, `leaked-error`, `incomplete`, `hallucinated-detail`. Every
citation is checked against the delivered text or its evidence, exactly as in
the PKM and goal-progress suites.

## Controls

Cross-job swaps: one job's real output presented as another job's. It is
structurally fine and wrong by construction, which is precisely what the
deterministic half cannot catch. Positive controls are unmodified rows that
passed every contract check; flagging one voids the run.

## Injected facts are part of the contract

When a pre-run script hands the model a number (commits in the last 36 hours,
the wiki page count), the report must copy it exactly. The failure this suite
exists to catch is a report that reads well and describes work that never
happened: a run once reported "wiki_list, 236 pages" after calling only a
prompt-listing tool twice.

## Two rules learned the hard way

- **Only active jobs count.** Jobs the owner disabled on purpose are excluded
  from the frozen corpus, the replay exam and the learning loop. Grading a
  disabled job's old sessions manufactures failures nobody asked to fix.
- **The model thinks, the script writes.** After repeated runs in which the
  on-device model claimed a consolidation it had not performed, and one that
  destroyed memory files with a whole-file write, the Auto-Dream job was split
  in two: the model answers with one JSON object, and a script snapshots the
  memory layers and applies it. The two halves are graded separately, and the
  brief that says what was applied is checked against what the script
  recorded.

## Who judges

Never the on-device model grading its own day. The audit half runs unattended
on the device: a silent script after the last daily job names only the runs
that broke their contract and the queue path a judge should grade. The
verdicts come from a separate session, and the ledger row records the probe
mode so a day is only compared with a day asked the same question.

## Where it lives

The runner, contracts and tests are in the Hermes fork
(`hermes_cli/hussh_one_routing/exam/jobs.py`, `hermes_cli/puppy_cmd.py`),
and the jobs themselves are versioned there under `scripts/hussh-one-cron/`
with a manifest and a sync that the daily updater runs whenever the fork
fast-forwards. The narrative of the first three judged passes (3 of 8, then
0 of 2, then 3 of 3 production grade in one day) is in that repository's
`docs/hussh-one/features/on-device-model-onboarding.md`.
