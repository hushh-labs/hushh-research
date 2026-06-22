# PR Train Scratch Retention

PR-governance runs write large scratch and report files into `tmp/` on every
wave, including autodrive, patch campaign, repass audits, live reports, and
contributor-impact dashboards. `tmp/` is gitignored, but unbounded growth bloats
the working copy.

Retention is enforced, not manual:

1. `scripts/maintenance/clean_tmp.sh` is the source of truth.
2. It age-outs files older than `RETENTION_DAYS` while keeping the newest
   `KEEP_PER_FAMILY` of each report family.
3. It prunes Python bytecode, empty dirs, and stale worktree metadata.
4. It refuses to run outside `<repo>/tmp` and supports `--dry-run`.
5. The daily `no_agent` Hermes cron runs it silently on success.
6. Interactive and cron PR-governance waves should run it at the end.

Do not use `rm -rf tmp/*`; that can destroy the 12-hour live-report cache and
in-flight resumable state. Reusable scratch such as
`tmp/pr-governance-live-report.md`, `tmp/autodrive-run.json`, and
`tmp/patch-queue.json` is protected by keep-last-N.
