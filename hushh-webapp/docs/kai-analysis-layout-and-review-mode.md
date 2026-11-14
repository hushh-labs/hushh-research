# Kai Analysis Layout + Review Mode Notes


## Visual Context

Canonical visual owner: [Hussh Webapp Docs](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Finance portfolio and analysis presentation

- Portfolio home keeps an 80px gain/loss ring and one primary performance figure. The distribution legend, movers, income and fees remain on Performance detail. Allocation uses a compact category list rather than stretching to the Performance card's height.
- Allocation detail presents asset mix, equity sectors and non-equity buckets as sections of one surface. Sector rows retain their full holding names, symbols, values and paging; categories are not limited to the former top eight. Each section labels its actual percentage denominator.
- Analyze on a selected stock uses the existing confirmed-start handler directly. Legacy ticker-preview entrypoints keep their confirmation path. Required owner/unlock checks, active-run handling and pending-navigation cancellation remain in place.
- Stock analysis leads with its existing result. Full debate/research and the detailed record expand in place; legacy `view` query values and action IDs remain supported. Opening details keeps the active stream controller mounted.
- This presentation pass does not change model prompts, scoring, analyst weights, provider selection, persona integration or the analysis backend.

## Global Top Spacing
- Root shell owns top spacing at layout level for all routes via `resolveTopShellMetrics(...)`.
- Effective top inset token is `--app-safe-area-top-effective`:
  - `max(var(--app-safe-area-top), env(safe-area-max-inset-top, 0px))`
  - `--app-safe-area-top` resolves to `var(--safe-area-inset-top, env(safe-area-inset-top, 0px))` so Android `SystemBars.insetsHandling = "css"` injected values are consumed first.
  - `.native-ios` forces `--app-safe-area-top/bottom` to WebKit `env(...)` values to avoid iOS underlap drift from injected var differences.
  - `--app-safe-area-top-offset` is derived from effective inset + top offset nudge.
- Scroll root contract uses route inputs from provider:
  - `--app-top-shell-visible` (`0/1`)
  - `--app-top-has-tabs` (`0/1`)
  - `--app-top-mask-tail-clearance` (visual fade tail clearance)
- Derived CSS geometry tokens:
  - `--app-top-tabs-shell-height`
  - `--app-top-shell-height`
  - `--app-top-content-offset`
- Route profile groups:
  - hidden shell: `/`, `/login`, `/logout`
  - visible shell with tabs: `/one/kai` family (except onboarding/import)
  - visible shell without tabs: remaining app routes by default
  - fullscreen-flow spacer exemption: `/one/kai/onboarding`, `/one/kai/import`
- Main scroll root inserts a structural spacer with `height: var(--app-top-content-offset)` so page content starts below top chrome even when nested layouts use full-height wrappers.
- Result:
  - Shell-visible routes (for example `/one/kai`, `/one/consent`, `/profile`) start below masked top chrome by default.
  - Page-level top padding hacks should not be added for shell overlap fixes.
  - Onboarding/import keep fullscreen-flow route behavior (spacer suppressed).

## Top Shell + Tabs
- Top chrome uses one unified visual layer:
  - `bar-glass` for status + header + route tabs
- Bottom chrome uses the same `bar-glass` class with direction variables (`to top`) instead of a separate class.
- Mask/frost styling is centralized in shared CSS tokens and consumed by `.bar-glass` only.
- Tail clearance is route-aware in `resolveTopShellMetrics(...)`:
  - compact clearance for non-tab routes
  - larger clearance for tab routes to avoid title/subtitle collision below tabs
- This keeps the swipe-tab active underline readable while preserving the masked top style.
- Header row is symmetric (`back | title | action`) using equal-width icon slots for Kai/Consents/Profile.
- Top and bottom masked areas intentionally use moderate blur (reduced from prior heavier values) for better readability while preserving the branded glass effect.
- System bars are managed via Capacitor `SystemBars` runtime control (theme-synced status + navigation bars) with `ios.contentInset = "never"` and `SystemBars.insetsHandling = "css"`.
- Native iOS bridge (`MyViewController`) keeps `webView.scrollView.contentInsetAdjustmentBehavior = .never` so UIKit does not reintroduce automatic top inset math that conflicts with the root shell contract.

## Analysis History Mobile Actions
- The 3-dot actions menu is the first table column:
  - `components/kai/views/columns.tsx`
- Menu trigger stops row click propagation for reliable touch behavior.

## Kai Preferences (PKM)
- Preferences are persisted to encrypted PKM path `financial.profile` via:
  - `lib/services/kai-profile-service.ts` (`KaiProfileService.savePreferences`, `KaiProfileService.setOnboardingCompleted`)
- Onboarding flow (post-auth + vault unlock):
  - `app/kai/onboarding/page.tsx` (wizard -> persona -> dashboard)
  - `components/kai/onboarding/KaiPreferencesWizard.tsx`
  - `components/kai/onboarding/KaiPersonaScreen.tsx`
- Dashboard editing uses a bottom sheet:
  - `components/kai/onboarding/KaiPreferencesSheet.tsx`

## App Review Mode Source of Truth
- Login screen now fetches review-mode config from backend at runtime:
  - `ApiService.getAppReviewModeConfig()`
- Reviewer login session token:
  - `ApiService.createAppReviewModeSession()` -> `AuthService.signInWithCustomToken(...)`
- Web path:
  - `GET /api/app-config/review-mode` (Next route proxy)
  - `app/api/app-config/review-mode/route.ts`
- Native path (iOS/Android):
  - `ApiService` points directly to backend, bypassing Next proxy.

## Native Auth Compatibility
- Reviewer login uses `AuthService.signInWithCustomToken(...)` (same on web + native).
