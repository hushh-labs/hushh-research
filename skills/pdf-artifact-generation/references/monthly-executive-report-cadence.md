# Monthly executive report cadence

Use this reference after the portable PDF skill when a leadership report needs a calendar-level
GitHub view. It is a current reporting procedure, not a performance-ranking or payroll method.

## Evidence collection

1. Declare one calendar month and one IANA local timezone before querying. The collector requires
   `--timezone` and converts GitHub's UTC timestamps to that timezone before both filtering and
   calendar placement. Never silently use UTC or the machine timezone for an executive report.
   State the chosen local timezone beside every calendar.
2. Supply a confirmed display-name-to-login mapping and the exact organization scope. The
   collector fetches organization visibility, identity membership, contribution-graph commits,
   opened/merged PR metadata, issues, reviews, and per-day PR/issue events.
3. Run the portable collector with an authenticated read-only `gh` session. It writes a frozen
   JSON evidence file and fails if a source query exceeds GitHub Search’s 1,000-result cap.
4. Keep the JSON with the requested artifact. Record the retrieval timestamp, visible repository
   count, source window, and any private-repository access limitation in the report.
5. Render each individual calendar directly from the frozen JSON; do not hand-transcribe source
   links or titles:

   ```bash
   python3 skills/pdf-artifact-generation/scripts/render_github_month_calendar.py \
     --input tmp/github-activity-YYYY-MM.json --person 'Display name'
   ```

## Calendar contract

For an executive GitHub work-progress audit, use `<!-- pdf:table=calendar-list -->`, not a
seven-day grid. It is a concise local-date ledger with `Local date | Recorded event | Audited
delivery`; it must show one source-linked representative change for every active date. Use the
seven-day `<!-- pdf:table=calendar -->` only when a spatial month view is genuinely more useful
than readable progress detail. Every otherwise inactive date must be represented in one or more
muted no-activity intervals; unexplained date gaps are a release blocker.

Example:

```markdown
<!-- pdf:table=calendar-list -->
| Local date | Recorded event | Audited delivery |
| --- | --- | --- |
| Jul 30 · Thu | M 7 · O 9 | [PR #4741](…) · [c abc1234](…) — granular connection scopes |
```

Define the legend in prose. For GitHub delivery reports, use `M` for PRs merged in the calendar
month, `O` for PRs opened, and `I` for non-PR issues created. Every active cell must name and
link one representative collected source: prefer the largest merged PR that day, then an opened
PR, then an issue. When a PR source has a head commit, link the short hash as a supporting audit
trail. The merge/open timestamp is a source-event date, not a claim that all implementation was
done that day. Never use a heatmap or a color scale to imply productivity.

## Executive narrative sequence

1. Open with the decision and the declared local-time calendar scope.
2. Give every individual a dedicated source-linked calendar list followed immediately by that person's KPI tracks,
   representative source-linked changes, and review/validation scope. An organization calendar is
   optional; it must not replace individual evidence.
3. Separate calendar events from delivery quality, hours, and outcomes.
4. End with a compact organization conclusion: what is evidenced, operational strengths, control
   gaps, and decisions required. Do not append a raw-statistics dump.

## Review gate

Before sharing, reconcile each individual calendar and the combined calendar totals against the
frozen JSON’s merged/opened/issue totals, sample representative PR files for each individual,
verify every calendar day belongs to the declared local-time window, and render/inspect every
calendar page. Event activity proves recorded GitHub
movement; it does not prove code correctness, production outcomes, human hours, or performance.
