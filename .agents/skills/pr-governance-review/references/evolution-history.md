# PR Governance Evolution History

This reference preserves operator-directed lessons without bloating the compact
`SKILL.md` kernel. Honor these rules alongside the focused PR train references.

1. `Two-stage merge topology.` Contributor PRs merge only to
   `integration/pr-train`. `main` is updated solely by a maintainer-only
   `integration/pr-train -> main` promotion PR. Agents never create or merge
   that promotion autonomously.
2. `No invented gates.` There is no "Autonomy Confidence Gate", "HIGH-band", or
   cap-of-8 model. Behavior is governed by this skill folder and checked repo
   contracts.
3. `Drive to terminal, every cycle.` A pass is not done after a green cohort.
   Every actionable PR must reach a terminal decision. Compute unattended state
   from the current maintainer record, not from `reviewDecision` alone.
4. `Whole-backlog, oldest-first, with caching.` Scan the open inventory, review
   oldest-first, reuse a complete 12-hour live report when valid, and never
   cache merge-safety verdicts across exact-head checks.
5. `Repass detection is mandatory and batched.` Compute contributor activity
   newer than the latest maintainer changes-requested record with batched
   GraphQL when possible.
6. `Agent-authored maintainer patches are default.` Actively strengthen aligned
   changes when repo evidence provides a safe patch; request changes only when a
   safe patch cannot be derived.
7. `Diff over path.` Sensitive paths require real diff reasoning. Security-
   positive changes on sensitive files may merge; hidden merge-authority edits
   or self-mock tests must not.
8. `Mentor communication personality.` Contributor-facing writes should show
   specific appreciation, an unambiguous decision, repo-truth reasoning,
   concrete next steps, fair credit, and firm boundaries without leaking
   governance internals.
9. `Attribution integrity.` A harvest is not complete until content and
   co-author credit are present on a durable ref. If credit is lost, acknowledge
   it and offer a transparent co-authored replay before closing the source PR.
10. `Automation lives in scripts/automation/.` `pr_train_autodrive.py` and
    `maintainer_patch_campaign.py` are the executable arms; keep them idempotent,
    resumable, and bounded for cron execution.
11. `Everlasting-run doctrine.` Every subprocess gets a timeout, record refresh
    comes before expensive merge work, budget is reserved for verify-to-zero,
    rate-limit assumptions are checked with `gh api rate_limit`, and repeated
    repass starvation changes wave ordering.
12. `Repass detection must use head-drift, not timestamps alone.` A 2026-06
    full reverification of all changes_requested PRs found 20+ PRs the
    contributor had genuinely fixed (head moved past the reviewed commit) that
    the timestamp-only detector missed — because a rebase keeps an old
    `committedDate` and an edited review body keeps an old `submittedAt`. The
    detector now flags a repass when EITHER (a) contributor activity is newer
    than the latest maintainer CR review, OR (b) the current head SHA differs
    from the `commit_id` that review was pinned to (head-drift, timestamp-
    immune). Head-drift is the source of truth for "code changed after review".
13. `Reverification is bounded by GraphQL quota.` The engine is GraphQL-heavy;
    running 3 parallel engine lanes exhausted the 5000/hr GraphQL budget and
    produced `review_scan_github_or_scan_error` false `block` verdicts. For any
    full-backlog sweep: check `gh api rate_limit` first, cap parallelism so the
    GraphQL budget lasts the run, and treat scan-error verdicts as
    needs-refetch, never as real decisions. A `merge_now`/`block` verdict is
    only trustworthy when the scan completed without a github/scan error.

When operator direction changes the model again, update this file and the
specific focused reference that owns the operational detail.
