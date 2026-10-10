# Profile Management Design Rules

## Visual Context

Canonical visual owner: [Hussh Webapp Docs](./README.md). Use that index for the package-level surface map; this page is the narrower profile-management rule beneath it.

## Purpose

Profile is a management surface, not a dashboard.

## Rules

- Use a single grouped settings-style index for Profile-scale navigation.
- Use disclosure rows that drill into focused detail panels instead of broad peer tabs.
- Use `SegmentedTabs` only for local state switches, not for primary page IA.
- Do not introduce KPI or dashboard summary grids on Profile by default.
- Default management pages should prefer:
  - hero identity or context
  - grouped navigation rows
  - state notices
  - compact metadata chips only when helpful
- Analytical metric cards are opt-in and should only be used when the product intent is explicitly analytical.

## Current Application

- `Profile` uses a single mobile-first grouped index with drill-in panels for `My Data`, `Access & sharing`, `Preferences`, `Security`, and support flows.
- PKM and consent panels use management cards and rows, not summary KPI strips.

## Account presentation guardrail

`Your account` owns the Profile pane's row geometry and type scale in
`components/profile/profile-your-account.module.css`. Payouts, Request pricing,
and Memory reuse `paneAccountContent` with `profile-account-content`; their
helper text and compact controls use `managedContent` from the same owner.

- Compose rows with `SettingsGroup` and `SettingsRow`, including transaction
  summaries. Use Profile's account/secondary outline icons and semantic colors.
- Keep one whole-row action with an inline label, as Display name and Phone
  number do. Do not place a large independent action button inside that row.
- Keep the existing 13px row title, 12px description/action and 10px section
  label scale. Add no feature-specific typography or card geometry.
- Give amounts and fees enough context: test earnings remain labelled
  `Test payment`; a Stripe transfer must not be called a bank deposit.
- Bank details remain masked. Changes open Stripe; users replace their payout
  bank before removing it. The app must not promise an unrestricted last-bank
  removal or a deposit merely because account setup is complete.
