# Loading Policy (App-Wide)


## Visual Context

Canonical visual owner: [Architecture Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Rule
Use only:
- top `StepProgressBar` for process/route progress
- static loading labels where needed (no inline progress bars/spinners)

Do not use spinner rotation or skeleton loaders.

## Implementation Notes
- `animate-spin` is disabled globally in `hushh-webapp/app/globals.css`.
- `HushhLoader` renders static loading labels only.
- `Spinner` renders a static placeholder glyph only.
- Route-level fetches should keep stale content visible while refresh runs.

## Why
- Avoids noisy loading states during frequent cache-first refreshes.
- Keeps UX consistent with step-based progress semantics.
- Prevents conflicting indicators when multiple async tasks overlap.

## Scope
This policy applies to:
- `/kai`, `/kai/portfolio`, `/consents`, and vault flows
- shared components under `hushh-webapp/components/ui/*`
