# Founder Brief Curation Rules

Use this reference when the user wants a shared architecture brief, founder PDF, or paper-style technical spec.

## Narrative Rules

1. Treat the document as a first-read artifact. Expand shortforms on first mention.
2. Make the opening thesis direct. Do not start by explaining what the document is not.
3. Keep the body platform-first. Avoid route inventories, file lists, and internal repo-process narration in shared sections.
4. Move implementation specificity into the exact places where it strengthens trust:
   - real endpoint names
   - real token names
   - real contract surfaces
   - real degraded-state or provenance rules
5. Keep a dedicated honesty section for current limitations and future-not-yet statements.

## Diagram Rules

1. Prefer three or fewer figures unless the user explicitly asks for more.
2. Use consistent box widths, gutters, and label scales across all figures.
3. Keep more padding than you think you need. Shared PDFs reveal crowding faster than HTML.
4. If text is close to an edge, make the box bigger or break the label into lines before shrinking the font.
5. Keep captions outside the figure geometry so the diagram can breathe.
6. When a layout feels asymmetric, fix geometry first:
   - equalize sibling column widths
   - re-center lanes and note blocks
   - shorten long connector spans
   - balance upper and lower group widths

## Shared-Artifact Rules

1. Remove internal drafting language such as:
   - how the brief was assembled
   - what sample file influenced it
   - repo-process provenance
   - prompt or workflow notes
2. Hyperlink the canonical references in the final HTML/PDF using shareable GitHub `blob/main` URLs, not local filesystem paths.
3. Keep branding local to the artifact when the user requests a one-off naming treatment.
4. Do not imply unbuilt architecture as current implementation truth.

## Verification Rules

1. Render the actual PDF before calling the artifact finished.
2. Verify the rendered document, not only the HTML source.
3. If available, export PDF pages to images and inspect the diagram pages directly.
4. Treat diagram overflow, clipped arrows, mis-centered lanes, and uneven gutters as blocking issues for a shareable artifact.
5. If visual tooling is unavailable, say so explicitly instead of pretending the layout is verified.
