# App Surface Audit Matrix


## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This matrix tracks the target design-system contract for the current application surfaces.

## Phase 1: Kai Investor Shell

| Surface | Target primitives | Status |
|---|---|---|
| `/kai/portfolio` | `PageHeader`, grouped surfaces, shared shell spacing | In scope for current investor shell contract |
| `/kai` Market | `PageHeader`, `SectionHeader`, compact list rows, shared market filter/list primitives | In scope and actively standardized |
| `/kai/investments` | `PageHeader`, `SettingsGroup`, `SettingsRow`, Plaid grouped sections | In scope for shared header + settings language |
| `/kai/analysis` | `PageHeader`, tabs, debate/history surfaces | In scope for heading and icon normalization |
| Consent center | `PageHeader`, grouped rows, detail panels | In scope for investor-facing consistency |
| Profile | canonical settings reference | Already the baseline |
| Top/bottom chrome | shared shell contract | Canonical layout authority |

## Phase 2: RIA and Marketplace Shell

| Surface | Target primitives | Status |
|---|---|---|
| `/ria` | `RiaPageShell`, grouped status band, simple route-launch rows | Simplified into lightweight workspace launcher |
| `/ria/onboarding` | shared shell spacing + page header contract | In scope for route-level review |
| `/ria/clients` | `SectionHeader`, `SettingsGroup`, `SettingsRow`, detail panel workflow | Simplified into mobile-first roster with Connected / Pending / Invites |
| `/ria/requests` | shared consent alias | Redirect-only compatibility route into `/consents` |
| `/ria/picks` | `RiaPageShell`, upload surface, grouped active/history rows | In scope and now part of the minimum RIA shell |
| `/ria/workspace?clientId=...` | `SectionHeader`, grouped access/data surfaces | Simplified into access summary + data view + request/disconnect actions |
| `/marketplace` | shared shell, grouped discovery rows/cards | In scope for audit cleanup |

## Open Follow-Through

1. Any new top-level route must use the shell spacing contract before shipping.
2. Any new actionable row/card must inherit the single-surface hover/ripple contract.
3. Any new heading must use a semantically grounded Lucide icon and the icon-left centered header pattern.
