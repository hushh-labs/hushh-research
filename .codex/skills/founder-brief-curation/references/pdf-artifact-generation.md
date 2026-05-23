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

2. Use the contributor-impact renderer only for the contributor dashboard:

   ```bash
   cd hushh-webapp
   node scripts/reports/export-contributor-impact-pdf.mjs \
     --input ../tmp/contributor-impact-dashboard.md \
     --output ../tmp/contributor-impact-dashboard.pdf \
     --html ../tmp/contributor-impact-dashboard.html
   ```

3. Do not try ad hoc `md-to-pdf`, `wkhtmltopdf`, `cupsfilter`, or browser-specific shell paths until the repo renderer fails. If the repo renderer fails because Playwright browsers are missing, install or use the repo's documented dependency path rather than creating a second renderer.

## Source Rules

1. Start from checked-in Markdown whenever possible.
2. Keep temporary source packets under `tmp/` and remove failed scratch files before finalizing unless the user asked to keep them.
3. Do not include `/Users/...`, `file://`, HCT tokens, bearer tokens, developer tokens, secrets, private wiki body text, or prompt provenance in shareable artifacts.
4. Mark current, future-state, and partner-confirmation-needed claims visibly in the source before rendering.
5. For Mermaid diagrams, accept the renderer's fallback view unless the user specifically asks for pixel-rendered diagrams. Pixel-rendered Mermaid needs separate rendered-image verification.

## Verification

1. Confirm the PDF exists and is non-empty.
2. Record page count from the rendered PDF when tooling is available.
3. Export or inspect rendered pages when available; otherwise state that visual page inspection was not completed.
4. Run hygiene searches over the source and rendered HTML for local paths and secrets before uploading or publishing.
5. For wiki/Drive uploads, prefer `wiki_artifact_save` with `artifact_type: "pdf"` and base64 PDF content so the wiki artifact has a Drive-backed binary.
