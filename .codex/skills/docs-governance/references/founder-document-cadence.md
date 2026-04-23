# Founder Document Cadence

Use this reference when the user asks for a founder-facing brief, PDF, or technical specification and supplies a sample such as `tmp/test.txt`.

## Purpose

Founder-facing artifacts are not ordinary maintained docs. They are presentation-grade documents whose primary job is to state architecture meaning with conviction while staying honest about current implementation truth.

## Required style

1. Follow the cadence of the provided founder sample before inventing a new structure.
2. Prefer numbered technical-spec sections over dashboard-like section labels.
3. Embed terminology in prose. Do not insert glossary panels such as `Founder Mapping` unless the user explicitly asks for a glossary.
4. Use declarative paragraphs, tables, figures, and explicit `Present State, Honestly Stated` style sections.
5. Keep the language architectural and argumentative. Avoid changelog tone, explainer-card tone, or onboarding-doc tone.
6. Start with a direct thesis, not a defensive caveat about what the document is not.
7. If the user asks for a platform pitch, let the title and first page be platform-first even when one product surface remains the narrative anchor.

## PDF layout rules

1. Prefer a paper or white-paper layout over landing-page cards.
2. Use diagrams only when they carry architectural meaning.
3. Keep diagrams and tables boxed, but let the document itself read as continuous prose.
4. Avoid brightly labeled panel grids that make the artifact feel like a product brochure.
5. Keep the figure system small and coherent. Prefer a few premium platform figures over many local diagrams.
6. Keep chapter rhythm intentional. Major new section titles should begin on a fresh page or on a deliberate title-divider page, not as leftovers beneath a preceding figure.
7. If a title-divider page is used, keep that page visually clean and move the body to the next page.
8. Do not single out one chapter with a different heading system unless the whole paper uses that system.
9. If the paper is organized around layers, follow the stack with explicit cross-layer pointers so the document explains both order and coherence.

## Truth rules

1. Founder-facing does not mean speculative.
2. Current-state claims must still map back to checked-in docs, code, routes, services, audits, and tests.
3. If the founder sample is future-state and the requested artifact is current-state, preserve the cadence but restate the truth level clearly in the prose rather than adding a separate mapping section.
