# Analytics Observability Review

Use this workflow pack when the task matches `analytics-observability-review`.

## Goal

Inspect and govern Kai analytics observability across GA4, Firebase Analytics, BigQuery export, dashboard query contracts, and environment-split verification.

## Steps

1. Start with `analytics-observability-governance` and use `owner skill only` as the default narrow path.
2. Run the non-mutating inspection helper before making topology or dashboard claims.
3. Keep production canonical and UAT validation-only unless policy changes explicitly.
4. Update observability docs, query contracts, and skill references in the same change.
5. Run the required repo verification commands before treating the observability surface as healthy.

## Common Drift Risks

1. treating shared auth as shared analytics
2. trusting GA UI cards instead of modeled SQL
3. forgetting to exclude non-Kai streams from growth reporting
4. assuming BigQuery export is complete before datasets and tables materialize
