# UAT Global Hierarchy And Spacing Audit

Status: Shared role foundation applied; rendered route verification is still pending.

## Visual Context

Canonical visual owner: [Quality and Design System Index](../reference/quality/README.md).

This file is the product-wide hierarchy evidence ledger for the UAT Apple iOS-first migration. It stays incomplete until every in-scope route has rendered proof across the route matrix and responsive matrix.

## Scope

This audit covers the product-wide Apple iOS-first hierarchy pass requested for UAT. The route inventory currently discovers 123 route files under `hushh-webapp/app`; `welcome` remains explicitly excluded by the migration prompt.

## Shared Typography Roles

Implemented shared semantic role primitives in `hushh-webapp/components/app-ui/typography.tsx`:

| Role | Shared primitive/class |
| --- | --- |
| Page title | `PageTitle`, `.ui-text-page-title` |
| Page subtitle | `PageSubtitle`, `.ui-text-page-subtitle` |
| Navigation title | `NavigationTitle`, `.ui-text-navigation-title` |
| Identity/person/agent name | `IdentityName`, `.ui-text-identity-name` |
| Major section title | `MajorSectionTitle`, `.ui-text-major-section-title` |
| Group/section label | `SectionLabel`, `.ui-text-section-label` |
| Card heading | `CardTitle`, `.ui-text-card-title` |
| Primary row label | `RowLabel`, `.ui-text-row-label` |
| Row secondary description | `RowDescription`, `.ui-text-row-description` |
| Trailing informational value | `TrailingValue`, `.ui-text-trailing-value` |
| Interactive trailing action | `TrailingAction`, `.ui-text-trailing-action` |
| Form label | `FormLabel`, `.ui-text-form-label` |
| Helper text | `HelperText`, `.ui-text-helper-text` |
| Button label | `ButtonLabel`, `.ui-text-button-label` |
| Tab label | `TabLabel`, `.ui-text-tab-label` |

## Shared Components Updated

| Component | Change |
| --- | --- |
| `PageHeader` | Uses `PageTitle`, `PageSubtitle`, and `SectionLabel` instead of local text sizes. |
| `SectionHeader` | Uses `CardTitle`, `PageSubtitle`, and `SectionLabel`; removed caption-sized title fallback. |
| `SettingsGroup` | Uses `SectionLabel` for all group headings and `RowDescription` for group descriptions. |
| `SettingsRow` | Uses `RowLabel` and `RowDescription`; destructive row color remains semantic red through the existing row tone. |
| `AdaptiveDetailSurface` | Sheet, drawer, and dialog headers now use navigation-title and row-description roles. |
| `FieldLabel`, `FieldTitle`, `FieldLegend`, `FieldDescription`, `FieldError` | Uses form-label, section-label, helper-text, and error roles. |
| `Button` | Base button typography now uses the shared button-label role. |
| `TopShellTabs` | Inactive tab labels use semantic secondary color instead of low opacity. |
| `TopShellBreadcrumbTrail` | Breadcrumb secondary labels and separators use semantic colors instead of opacity fading. |
| Morphy surface typography constants | `SCREEN_TITLE`, `SECTION_HEADING`, `MUTED_TEXT`, and `EYEBROW` now point at shared role classes. |

## Global Token Work

Added shared Apple iOS-first typography variables to `hushh-webapp/app/globals.css`, including:

- page title: 28px / 700 / 32px / -0.022em
- navigation title: 17px / 600 / 22px / -0.01em
- section label: 15px / 500 / 20px / -0.01em / `#6E6E73`
- row label: 17px / 400 / 22px
- row description and trailing value: 15px / 400 / 21px / `#8E8E93`
- form label: 15px / 500 / 20px
- helper text: 13px / 400 / 18px
- button label: 17px / 600 / 22px
- tab label: 11px / 500 / 13px, reserved for compact tab surfaces

The end-of-file semantic typography guardrail intentionally overrides older `h1`/`h2` and `data-slot` fallback rules so shared role classes win consistently.

## Source Audit Findings

Current source scan still shows route-local tiny and uppercase text usage, especially in dense finance tables, metadata badges, developer docs, Gmail receipts, marketplace cards, and chart labels. These are not all defects: some are true metadata, data-table headings, legal/microcopy, or compact badges. They remain pending until each route is rendered and classified by role.

Known high-risk role mismatches still requiring rendered review:

- RIA picks tables and editor metadata.
- Gmail receipt/nudge section headings.
- Kai finance dashboard cards, chart labels, badges, and history widgets.
- Marketplace metadata and status chips.
- Developer docs hub labels.
- One Location map overlays and onboarding sheets.

## Verification

Completed:

- TypeScript check: `npm run typecheck`
- Design-system check: `npm run verify:design-system`
- Cache contract tests: `npm run verify:cache`
- Docs check: `npm run verify:docs`
- Lint: `npm run lint`

Blocked:

- Signed-in route rendering: `npm run verify:routes` is blocked locally because `REVIEWER_UID` and `REVIEWER_VAULT_PASSPHRASE` are not present in the maintainer-only environment.

Pending before this audit can be marked complete:

- `npm run verify:routes` or UAT route verifier with authenticated reviewer context
- Rendered proof for each route in `docs/ui-migration/route-matrix.md`
- Viewport proof at 320, 375, 390, 393, 430, 768, 820, 1024, 1280, and 1440 widths
- iOS Safari safe-area and keyboard proof
- UAT deployment and UAT visual recheck

## Completion Rule

This audit is not complete yet. It can only be marked complete after every in-scope route has rendered evidence for typography hierarchy, spacing rhythm, semantic color, responsive behavior, iOS safe-area/keyboard behavior, and shared-component conformance.
