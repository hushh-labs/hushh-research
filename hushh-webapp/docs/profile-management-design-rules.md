# Profile Management Design Rules

## Visual Context

Canonical visual owner: [Hussh Webapp Docs](./README.md). Use that index for the package-level surface map; this page is the narrower profile-management rule beneath it.

## Purpose

Profile is a management surface, not a dashboard.

## Rules

- Use a single grouped settings-style index for Profile-scale navigation.
- Use disclosure rows that drill into focused detail panels instead of broad peer tabs.
- Use `SettingsSegmentedTabs` only for local state switches, not for primary page IA.
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
