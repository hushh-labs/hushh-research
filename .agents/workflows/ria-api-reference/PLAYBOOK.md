# RIA API Reference

Use this workflow pack when the task matches `ria-api-reference`.

## Goal

Keep RIA facade routes, proxy behavior, tests, and docs aligned with the provider contract.

## Steps

1. Start with `backend` and route narrowed RIA facade work to `ria-api-reference`.
2. Read repo-local CRD scraping and API contract docs before changing routes or tests.
3. Preserve the facade boundary: forward to the provider, surface provider errors clearly, and avoid scraper duplication.
4. Run the focused CRD scraper route test and skill lint.

## Common Drift Risks

1. duplicating provider scraper logic in this repo
2. changing payload shape without test coverage
3. relying on private local provider paths as durable repo truth
