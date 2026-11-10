# Monthly executive GitHub activity report

Use this reference for a founder/CTO readout of what named contributors changed in a GitHub
organization during one month. The report is an evidence-linked delivery narrative, not a
timesheet, productivity score, compensation input, or proof of production outcomes.

## Evidence collection

1. Declare the organization, calendar month, IANA timezone, and requested contributors. Confirm
   each display-name-to-login mapping and organization membership from available evidence. Mark
   email attribution as unconfirmed when GitHub does not expose enough evidence; do not infer it.
2. Use the portable read-only collector with an authenticated `gh` session:

   ```bash
   python3 .agents/skills/pdf-artifact-generation/scripts/collect_github_month.py \
     --org hushh-labs --month YYYY-MM --timezone America/Los_Angeles \
     --person 'Display name=github-login' \
     --output tmp/github-activity-YYYY-MM.json
   ```

   The required timezone controls source-window filtering and local-date placement. Preserve the
   frozen JSON beside the requested artifact, with collection time, source window, visible repo
   count, and private-repository access limits disclosed.
3. For file-level detail, enumerate the author-dated commits included by the declared repository
   scope, then request commit details for the representative commit on each active contributor
   date. Retain returned paths, file status, additions/deletions when available, source URLs, and
   the selection method in a companion evidence file. A commit title is not a substitute for
   inspecting its changed files. Do not imply the sampled commit is the contributor's only work
   that day.
4. Keep GitHub's contribution-graph total separate from API-enumerated author-dated commits when
   the collection methods differ. State the definitions, the difference, and the enumeration
   limits; never force the totals to reconcile or invent missing commits. Preserve the collector's
   failure on GitHub Search's 1,000-result cap rather than silently accepting truncated data.
5. Render sources from frozen evidence rather than hand-transcribing dates, titles, or links:

   ```bash
   python3 .agents/skills/pdf-artifact-generation/scripts/render_github_month_calendar.py \
     --input tmp/github-activity-YYYY-MM.json --person 'Display name'
   ```

## Executive report structure

Follow this order so the reader gets the month-level readout before the engineering ledger:

1. **Cover dashboard:** use the executive physical cover with the report title, organization,
   month/timezone, and one short synthesis grounded in the collected subjects. Use a restrained
   metrics rail for contributors, contribution-graph commits, PRs merged, and PRs opened. Put
   issues, reviews, and visible repository count in a supporting line. Add a clear activity-data
   limitation. Do not turn the cover into an engineering changelog or a decorative dashboard.
2. **People and evidence index:** list each contributor once with a short, neutral focus summary.
   Define the date/event measures and attribution limits here, including the distinction between
   graph counts and enumerated commits when applicable.
3. **One section per person, in the requested order:** start with a 2–4 sentence generative
   summary, then that person's monthly KPI line, then the daily detail. Ground summaries in
   PR descriptions and changed paths: name the product area, the meaningful behavior or system
   boundary touched, and relevant tests/contracts/operations work. Mention representative file
   names. Avoid generic praise, inferred effort, and unsupported claims about quality or impact.
4. **Organization readout and source note:** state the cross-team themes supported by the files,
   what the evidence cannot establish, retrieval date, scope, and where the frozen evidence lives.
   Keep it concise; do not append an unexplained raw-statistics dump.

Use this profile shape:

```markdown
## Contributor name

**Generative summary:** [What their changes addressed, supported by representative paths and
tests/contracts; distinguish product work from operational or documentation work.]

**Monthly activity:** contribution-graph commits N · enumerated author-dated commits N ·
PRs opened/merged N/N · issues N · reviews N.

**Daily detail:** [State that one representative commit is selected per active commit date,
that file paths are actual API-returned changed paths, and that linked diffs contain full detail.]

<!-- pdf:table=calendar-list -->
| Local date | Recorded event | Commit and files changed |
| --- | --- | --- |
| Aug 12 · Wed | C 4 · M 1 | [commit](URL) concise change — M `path/to/service.py`; A `path/to/test.py`; +2 more files |
```

In the index and daily ledger, define `C` as author-dated commit records enumerated for that local
date, `M` as pull requests merged during the month, `O` as pull requests opened, `I` as issues
created, and `V` as review events. These are source events and counts, not estimates of time spent.

## Daily ledger and file-detail contract

For executive work-progress reports, use `<!-- pdf:table=calendar-list -->`: one source-linked row
per active local date with `Local date | Recorded event | Commit and files changed`. Render every
day in the month, grouping contiguous no-event dates into muted intervals. A date with a PR, issue,
or review but no author commit must say so; never present the PR open/merge timestamp as the date
the implementation was performed.

For each active commit date, show the commit count and one representative substantive commit. Prefer
a non-merge commit when available; label validation-only or merge-only selections accurately. Link
the full commit diff and show up to two actual changed paths with status (`A`, `M`, `D`, or `R`),
plus the count of remaining files. Keep the complete returned file list in evidence. For PR-only
days, link the PR and show actual changed paths from its file listing. Use `M` for merged PRs, `O`
for opened PRs, `I` for issues created, and `V` for review events; define these in nearby prose.
Do not use heatmaps, colors, or rankings to imply productivity.

## Render and review

Use the common Foundation exporter from the portable PDF skill. For Markdown-to-PDF, choose the
`executive` profile and a published theme; do not add artifact-local CSS or a renderer. Before
sharing, verify:

- the full-bleed cover and subsequent page margins render correctly;
- the cover reads as an executive summary/dashboard, followed by a usable people/evidence index;
- all requested people have a summary, metrics, and file-backed daily detail;
- every month date is represented and every active ledger row has the correct source link;
- representative paths match the frozen GitHub commit/PR file response;
- no profile heading is stranded, no table clips, and no accidental empty pages appear;
- source window, timezone, account attribution caveats, and graph/API count differences are
  explicit; no local-only links or secrets are present.

Activity shows recorded repository movement. It does not establish hours, compensation, individual
performance, correctness, shipped behavior, or production outcomes.
