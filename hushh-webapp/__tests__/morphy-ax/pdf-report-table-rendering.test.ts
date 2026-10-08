import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../../scripts/reports/export-markdown-pdf.mjs";

describe("PDF report table rendering", () => {
  it("renders allow-listed table variants with alignment, labels, and summary semantics", () => {
    const html = renderMarkdown(`<!-- pdf:table=ledger -->
| Contributor | Merged |
| --- | ---: |
| Ankit | 66 |
| **Combined** | **66** |`);

    expect(html).toContain('class="pdf-table pdf-table--ledger"');
    expect(html).toContain('<th scope="col" data-align="end">Merged</th>');
    expect(html).toContain('<td data-label="Merged" data-align="end">66</td>');
    expect(html).toContain('<tr data-summary="true">');
    expect(html).not.toContain("pdf:table=ledger");
  });

  it("does not let an unsupported directive leak a style into the following table", () => {
    const html = renderMarkdown(`<!-- pdf:table=not-a-variant -->
| Metric | Value |
| --- | --- |
| PRs | 578 |`);

    expect(html).toContain('class="pdf-table pdf-table--standard"');
    expect(html).not.toContain("not-a-variant");
  });

  it("keeps a profile together and closes it even when the source omits the closing directive", () => {
    const html = renderMarkdown(`<!-- pdf:profile-start -->
### Ankit

<!-- pdf:table=metrics -->
| Delivery | Review | Attention |
| --- | --- | --- |
| 66 July merges | 12 reviews | One PR remains open. |`);

    expect(html).toContain('<section class="pdf-profile">');
    expect(html).toContain('class="pdf-fact-rail pdf-fact-rail--rail"');
    expect(html.endsWith("</section>")).toBe(true);
  });

  it("turns a wide single-row metric set into an editorial metric deck", () => {
    const html = renderMarkdown(`<!-- pdf:table=metrics -->
| Opened | Merged | Resolution | Commits | Reviews |
| ---: | ---: | ---: | ---: | ---: |
| 609 | 578 | 95.9% | 1,143 | 234 |`);

    expect(html).toContain('class="pdf-fact-rail pdf-fact-rail--deck"');
    expect(html).toContain('<span class="pdf-fact-label">Resolution</span>');
    expect(html).not.toContain("<table");
  });

  it("renders a seven-day monthly activity calendar as a semantic grid", () => {
    const html = renderMarkdown(`<!-- pdf:table=calendar -->
| Mon | Tue | Wed | Thu | Fri | Sat | Sun |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | **1** :: M 18 · O 6 :: [PR #4741](https://github.com/hushh-labs/hushh-research/pull/4741) · [c abc1234](https://github.com/hushh-labs/hushh-research/commit/abc1234) — granular scopes | **2** :: M 14 · O 4 :: A · K | **3** :: M 9 · I 2 :: J · K | — | — |`);

    expect(html).toContain('class="pdf-calendar"');
    expect(html).toContain('class="pdf-calendar-day pdf-calendar-day--empty"');
    expect(html).toContain('<span class="pdf-calendar-date"><strong>1</strong></span>');
    expect(html).toContain('<span class="pdf-calendar-measure">M 18 · O 6</span>');
    expect(html).toContain('href="https://github.com/hushh-labs/hushh-research/pull/4741"');
    expect(html).toContain('href="https://github.com/hushh-labs/hushh-research/commit/abc1234"');
    expect(html).not.toContain('class="pdf-table pdf-table--calendar"');
  });

  it("renders a source-linked activity calendar as a readable dated list", () => {
    const html = renderMarkdown(`<!-- pdf:table=calendar-list -->
| Local date | Recorded event | Audited delivery |
| --- | --- | --- |
| Jul 30 · Thu | M 7 · O 9 | [PR #4741](https://github.com/hushh-labs/hushh-research/pull/4741) · [c abc1234](https://github.com/hushh-labs/hushh-research/commit/abc1234) — granular scopes |`);

    expect(html).toContain('class="pdf-calendar-list"');
    expect(html).toContain('class="pdf-calendar-list-item"');
    expect(html).toContain('class="pdf-calendar-list-date">Jul 30 · Thu</span>');
    expect(html).toContain('href="https://github.com/hushh-labs/hushh-research/pull/4741"');
    expect(html).not.toContain('class="pdf-table pdf-table--calendar-list"');
  });

  it("keeps an executive cover and its decision as semantic renderer units", () => {
    const html = renderMarkdown(`<!-- pdf:cover-start -->
Executive verdict.

<!-- pdf:callout=decision -->
Executive decision.
<!-- pdf:callout-end -->
<!-- pdf:cover-end -->`);

    expect(html).toContain('<section class="pdf-cover">');
    expect(html).toContain('<section class="pdf-callout pdf-callout--decision">');
    expect(html).not.toContain("pdf:cover-start");
    expect(html).not.toContain("pdf:callout=decision");
  });
});
