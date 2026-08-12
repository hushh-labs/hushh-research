# PDF Artifact Generation Workflow

Use this reference for generic Markdown/HTML/PDF report artifacts when no narrower skill owns the export.

## Renderer Choice

1. Prefer the repo generic renderer:

   ```bash
   cd hushh-webapp
   node scripts/reports/export-markdown-pdf.mjs \
     --input ../path/to/source.md \
     --output ../tmp/output.pdf \
     --html ../tmp/output.html \
     --title "Artifact title" \
     --subtitle "Optional subtitle"
   ```

   The renderer supports the four canonical themes: `--theme light` (default),
   `--theme dark`, `--theme molten-gold-light`, and `--theme molten-gold`. These are
   two Foundation grounds crossed with two accents (iOS Blue, Molten Gold). The names
   are a published contract -- documents in circulation name them, and the DocuSign
   document is `molten-gold-light` -- so they may not be renamed without migrating
   those call sites. Use `molten-gold` for a dark editorial artifact that
   should follow the live Morphy Molten Gold preference. Its accent values are
   read from `hushh-webapp/app/globals.css`; do not recreate that palette with
   local hex values or use gold as body-text decoration.

2. Use the PR governance skill refresh command for the contributor dashboard:

   ```bash
   python3 .codex/skills/pr-governance-review/scripts/refresh_contributor_impact_dashboard.py --repo hushh-labs/hushh-research --days 14 --mode fast
   ```

   The scoring, report copy, and contributor-dashboard PDF formatter stay
   canonical in the `pr-governance-review` skill. Do not add a webapp-local
   contributor-impact exporter.

3. Do not try ad hoc `md-to-pdf`, `wkhtmltopdf`, `cupsfilter`, or browser-specific shell paths until the repo renderer fails. If the repo renderer fails because Playwright browsers are missing, install or use the repo's documented dependency path rather than creating a second renderer.

## Source Rules

1. Start from checked-in Markdown whenever possible.
2. Keep temporary source packets under `tmp/` and remove failed scratch files before finalizing unless the user asked to keep them.
3. Do not include `/Users/...`, `file://`, HCT tokens, bearer tokens, developer tokens, secrets, private wiki body text, or prompt provenance in shareable artifacts.
4. Mark current, future-state, and partner-confirmation-needed claims visibly in the source before rendering.
5. For Mermaid diagrams, accept the renderer's fallback view unless the user specifically asks for pixel-rendered diagrams. Pixel-rendered Mermaid needs separate rendered-image verification.

## Information Architecture And Density

1. Before rendering, turn wrapped source lines into semantic paragraphs; a
   source line-wrap must never become artificial vertical whitespace in the PDF.
2. Choose the smallest clear structure for each idea: ordered steps for a
   lifecycle, a table for repeated comparisons, and a code block only for
   copyable protocol material. Do not use one-line paragraphs as a substitute
   for structure.
3. During rendered-page review, check paragraph grouping, page-width use,
   heading continuity, table fit, and unexplained empty space. Rework source
   structure or renderer semantics before accepting a sparse page.
4. Preserve reading rhythm: group context with the action it explains, avoid
   duplicated caveats, and keep current-state, future-state, and
   partner-confirmation-needed claims visibly distinct.

## Formatter Ownership And Brand Variants

1. The Markdown-to-PDF script is a generator, not a visual fork. It must use
   `hushh-webapp/lib/morphy-ux/pdf-document-formatter.mjs` for portable-document
   visual tokens and audience profiles.
2. Select a formatter profile for the reader: `technical` for internal
   implementation references, `partner` for integration guides, or `founder`
   for an editorial brief. Profiles may change density and hierarchy, never the
   Hussh brand grammar or the truth boundary.
3. Select `light`, `dark`, `molten-gold-light`, or `molten-gold`. Light and dark must
   take `hu` ink and the `ssh` foil gradient from the app's Foundation tokens;
   only the explicit gold theme may use the Molten Gold variant.
4. Copyable code follows the selected document theme. Light PDFs use the
   Sublime-inspired light code surface with dark ink and accessible
   magenta/green/purple syntax tokens. Dark and Molten Gold PDFs use Sublime
   Text Monokai: `#272822` background, `#f8f8f2` foreground, and the
   established pink/yellow/purple syntax tokens. Do not replace either code
   surface with prose-card styling.
5. Rendered review remains mandatory for every profile. Verify wordmark
   contrast, usable page width, semantic paragraph/list grouping, code legibility,
   table fit, and page breaks before publishing.

## Verification

1. Confirm the PDF exists and is non-empty.
2. Record page count from the rendered PDF when tooling is available.
3. Export or inspect rendered pages when available; otherwise state that visual page inspection was not completed.
4. Run hygiene searches over the source and rendered HTML for local paths and secrets before uploading or publishing.
5. For wiki/Drive uploads, prefer `wiki_artifact_save` with `artifact_type: "pdf"` and base64 PDF content so the wiki artifact has a Drive-backed binary.


## Canonical paths — the single source of truth

Document generation has exactly one lane. Any other PDF or document pipeline in this
repository is deprecated; do not add a second one.

| Concern | Canonical path |
|---|---|
| Curation + authoring rules | `.codex/skills/founder-brief-curation/SKILL.md` |
| PDF artifact procedure | `.codex/skills/founder-brief-curation/references/pdf-artifact-generation.md` (this file) |
| Formatter + theme contract | `hushh-webapp/lib/morphy-ux/pdf-document-formatter.mjs` |
| Exporter (CLI) | `hushh-webapp/scripts/reports/export-markdown-pdf.mjs` |
| Design tokens | `hushh-webapp/app/globals.css` |
| Design system rules | `docs/reference/quality/design-system.md` |

**Deprecated:** `.claude/skills/morphy-pdf/` is a divergent parallel copy with its own CSS,
its own embedded fonts and its own renderer. It never reads `globals.css`, so its output
does not follow the Foundation tokens or the accent preference, and it cannot express
`molten-gold-light`. It is retained read-only; do not extend it.

### Why the theme list is guarded by a test

`hushh-webapp/__tests__/morphy-ax/pdf-theme-canon.test.ts` pins all four themes and drives
the REAL `resolveFormatter`, not a copy of it. Two of the four were broken simultaneously
and nothing caught it:

* `molten-gold-light` did not exist. The gold light token block was present in
  `globals.css`, but the exporter hardcoded `useDarkFoundation = theme !== "light"`, so
  gold could only pair with a dark ground.
* `dark` threw `Missing Morphy accent token(s)` for all seven accent names on every
  invocation it had ever had. `globals.css` declares `.dark` several times by design and
  the resolver sampled only the FIRST and LAST blocks; the one carrying the
  `--app-accent-*` family sat between them and was dropped.

The test imports the shipped resolver deliberately. An earlier version reimplemented the
resolution logic and passed against broken code -- which is exactly how `dark` survived
every prior run.
