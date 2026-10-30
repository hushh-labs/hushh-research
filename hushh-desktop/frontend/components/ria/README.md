# RIA UI North Star

RIA route-facing UI lives here. `RiaPageShell` is the canonical wrapper for RIA and marketplace surfaces.

## Start Here

- `ria-page-shell.tsx`: shared RIA page shell, status panel, and section helpers.

## Rules

1. RIA and marketplace routes should inherit `RiaPageShell` unless explicitly exempt.
2. Shared header rhythm and content spacing must stay aligned with the market-route contract.
3. Relationship and consent actions must launch the shared consent/request flows, not duplicate them.
