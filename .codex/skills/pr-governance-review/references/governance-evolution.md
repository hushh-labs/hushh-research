# PR Governance Evolution

This skill matured through operator-directed iterations. The current operating
model is the sum of these; honor all of them:

1. `Two-stage merge topology.` Contributor PRs merge ONLY to
   `integration/pr-train` (never `main`). `main` is updated solely by a
   maintainer-only `integration/pr-train -> main` promotion PR, which agents
   never create or merge autonomously (`config/ci-governance.json` →
   `branch_flow` / `main_allowed_head_branches` is the source of truth). Every
   "merge"/"queue" action this skill performs is a train-level action.
2. `No invented gates.` There is NO "Autonomy Confidence Gate / HIGH-band /
   cap-of-8" model — that was a launcher invention and is retired. Behavior is
   governed only by the files in this skill folder.
3. `Drive to terminal, every cycle.` A pass is not done after a green cohort.
   Every actionable PR must reach a terminal decision (see No-Unattended
   Invariant in `pr-train-write-contract.md`). Compute "unattended" from the
   presence of a current maintainer record, NOT `reviewDecision` alone — a later
   APPROVED/DISMISSED supersedes an earlier CHANGES_REQUESTED.
4. `Whole-backlog, oldest-first, with caching.` Scan the full open inventory
   (hundreds of PRs), deep-review oldest-first, reuse the live report for 12h,
   and advance via `--exclude-prs-file` tranche refill. Never cache merge-safety
   verdicts; Exact-Head Queue Safety re-reads live state before every write.
5. `Repass detection is mandatory and batched.` GitHub's UI cannot show whether
   a CHANGES_REQUESTED PR was addressed; compute it (latest contributor activity
   vs latest maintainer changes-requested review), batched via aliased GraphQL.
6. `Agent-authored maintainer patches are the DEFAULT`, not a human handoff, per
   the Agent-Authored Maintainer Patch Authority gate. Actively strengthen the
   change; test evolution counts as valid proof. Only fall back to
   `request_changes` when a safe patch cannot be derived from repo evidence.
7. `Diff over path.` Sensitivity is judged from the actual diff, not the file
   path. A benign/security-positive change on a sensitive path may merge; a
   self-mock test or a hidden `config/ci-governance.json` merge-authority edit
   must not.
8. `Mentor communication personality` governs every contributor-facing write
   (see `comment-templates-and-reporting.md`): specific appreciation,
   unambiguous decision, repo-truth why, concrete next step, encouragement,
   firm-but-kind on non-negotiable boundaries, no governance leakage, fair
   credit.
9. `Attribution integrity.` A harvest is not complete on a temporary-branch
   commit; verify content AND co-author credit on a durable ref before closing
   source PRs. If credit was lost, acknowledge it and offer a transparent
   co-authored replay before closing (see the harvest ledger's Lesson Recorded).
10. `Automation lives in scripts/automation/.` `pr_train_autodrive.py` (daily
    drive-to-terminal) and `maintainer_patch_campaign.py` (trust-boundary patch
    drain) are the executable arms; the daily train cron and the patch campaign
    cron invoke them. Keep them idempotent + resumable for the 600s cron idle
    limit.

When operator direction changes the model again, update this list AND the
specific reference file so the evolution stays self-describing.
