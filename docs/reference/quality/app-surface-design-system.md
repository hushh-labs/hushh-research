# App Surface Design System


## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document is the canonical contract for app-facing surfaces across Kai, RIA, Marketplace, Consent, and Profile.

Profile remains the reference implementation for settings rows. This document expands that language into the broader page-shell, header, and content-surface system.

## Shell Contract

1. The top shell is the single authority for header clearance.
2. Standard routes must reserve top space through `--top-shell-reserved-height`, not raw `env(safe-area-inset-top)`.
3. Standard page roots own their own start spacing through `padding-top: var(--page-top-start)`.
4. Do not solve overlap by adding bottom padding to the fixed top bar or by inserting route-local spacer nodes above page content.
5. Shared page-shell wrappers such as `RiaPageShell` and consent/profile/Kai route roots must apply the same page-start token.
6. Raw safe-area math is allowed only for true fullscreen or overlay surfaces that do not participate in the normal shell.
7. Native iOS stays aligned with:
   - `ios.contentInset = "never"`
   - `SystemBars.insetsHandling = "css"`
8. Decorative glass fade is visual-only and must never add extra content spacing.
9. Signed-in app pages default to `compact` density through `AppPageShell`; route-level spacing overrides are the exception, not the norm.
10. Compact density tightens page headers, section headers, card padding, list/table rows, and pagination spacing through shared CSS variables rather than page-local class tweaks.
11. Back, persona, shield, and bell interactions must use the shared shell action surface so ripple, focus, contrast, and badge positioning stay consistent.
12. Dropdown-triggered shell actions must accept a wrapper or render-trigger contract when the shell owns interaction behavior.
13. `AppPageShell` owns route width and horizontal gutters for signed-in routes.
14. The canonical shell widths are:
   - `reading`
   - `standard`
   - `expanded`
15. The canonical container tokens are:
   - `--app-shell-reading: 54rem`
   - `--app-shell-standard: 90rem`
   - `--app-shell-expanded: 96rem`
16. Signed-in app routes default to `standard`; use `reading` only for narrow detail/settings pages and `expanded` for dashboard/table-heavy routes.
17. Route files must not add their own outer `max-w-* mx-auto px-*` shells when `AppPageShell` or `FullscreenFlowShell` already owns the page container.
18. `top-app-bar` and fixed route-tab chrome must align to the same `standard` shell width as page content.
19. Mobile uses page gutters, not a second outer card container. Surface padding belongs inside cards, lists, sheets, and insets.
20. `SurfaceStack` overscan is allowed only as shared shell breathing on tablet/desktop; mobile defaults stay edge-aware and minimal.
21. Signed-in nested routes must expose a back affordance through the shared top bar when they drill below a parent workspace route.
22. Route-local inline back buttons are reserved for contexts that do not participate in the shared shell, such as modal, sheet, or fullscreen-flow surfaces.
23. Signed-in route verification is contract-driven. `hushh-webapp/lib/navigation/app-route-layout.contract.json` is the browser coverage source of truth for `npm run verify:routes`.
24. Signed-in route work is not complete until the route-contract Playwright sweep passes with the reviewer login and vault-unlock path.

## Page Header Contract

Use `PageHeader` and `SectionHeader` for all top-level and section-level headings.

Rules:

1. The icon sits on the left and is centered against the full header block:
   - eyebrow
   - title
2. On mobile, description becomes a full-width third row aligned with the page content edge, not nested under the icon.
3. The icon well should feel sized for the title block, not stretched to a full three-row mobile stack.
4. Titles and descriptions stay compact and readable on mobile first.
5. Do not stack a second decorative icon inside the same header block.
6. If a section already has a header icon, omit redundant per-row decorative icons unless the row needs them for real semantic distinction.
7. Accent divider lines stay constant across the full width; do not fade them to transparent.
8. Header accents must come from the shared semantic accent map, not route-local color recipes.
9. Approved route-role accents are:
   - `kai`
   - `ria`
   - `consent`
   - `marketplace`
   - `developers`
   - `neutral`
10. Success, warning, and critical accents are reserved for explicit status communication, not page identity.

## Row and Card Interaction Contract

Rules:

1. If a row or card is actionable, the entire surface owns hover, press, and ripple.
2. Inner text blocks must not create a second hover state.
3. The trailing slot stays pinned right unless the design explicitly calls for a stacked mobile layout.
4. Use one interaction layer per surface.
5. `SettingsRow` is the default interactive list row contract and should be reused outside Profile when the surface is row-like.
6. Standalone actions should use the shared `Button` primitive so ripple, loading, and emphasis stay consistent across the app.
7. Do not ship raw clickable pills or text links for primary app actions when a shared button or row primitive already exists.
8. Browse-heavy managers should prefer compact row/tape treatments over card-per-item layouts when the user is scanning lists, holdings, picks, requests, or rosters.

## Consent Inbox And Notification Contract

Rules:

1. The bell is one notification surface for background tasks and push events, not a tabbed mini-app.
2. The shield is the consent inbox.
3. The shield badge must come from consent-center summary data for the active persona, not notification-local counters.
4. The first-party shield inbox should reuse the cached `pending page 1` manager payload and render the first `5` rows from that list instead of creating a second cache lane.
5. The inbox dropdown must stay compact:
   - fixed width
   - bounded height
   - internal scroll only
   - no pagination chrome inside the dropdown
6. Bell and shield dropdowns should share the same top-shell dropdown chrome:
   - same radius
   - same border/backdrop treatment
   - same header/body/footer spacing
   - same device-width scaling rules
7. Bell, shield, profile, and compatibility aliases must converge on the same `/consents` manager when the user chooses to open the full workspace.
8. Delivery diagnostics do not belong in the bell or shield inbox.
9. Notifications remain visible until dismissed and should be ordered newest-first.
10. Consent-review actions triggered from toasts or push taps must use in-app router navigation for internal app routes so vault-backed sessions are not cold-restarted.
11. The bell is a two-level async surface:
    - primary work for long-running/recoverable tasks such as PKM upgrade, portfolio import, Plaid refresh, consent export refresh
    - passive work for cache warm, silent refresh, and reconciliation
12. Passive work should only surface after a short threshold, stay grouped under `Background activity`, and autoclear after success.
13. Failed passive work must promote into the primary task list and remain visible until dismissed.

## Scroll Stability Contract

Rules:

1. Desktop standard signed-in scroll roots must reserve stable scrollbar space.
2. Variable-height tab/content changes must not cause page-width drift.
3. Solve this in the shared shell scroll container, not with route-local hacks.

## Surface Card Contract

Rules:

1. Shared app cards must originate from the `surface` card preset, not page-level radius/shadow recipes.
2. The primitive source of truth lives in `lib/morphy-ux/surfaces.tsx`.
3. App pages should consume `SurfaceCard`, `ChartSurfaceCard`, `FallbackSurfaceCard`, and `SurfaceInset` through `components/app-ui/surfaces.tsx`.
4. `Card` remains the low-level primitive. App pages should not re-specify:
   - outer radius
   - outer shadow
   - border opacity
   - glass background treatment
5. Standard header/content spacing for app-facing cards must come from:
   - `SurfaceCardHeader`
   - `SurfaceCardContent`
   - `SurfaceCardTitle`
6. Page files may control layout width and grid placement, but not reinvent card chrome.
7. Nested content should use `SurfaceInset` or another semantic surface helper instead of raw `rounded-[..] border bg ...` blocks where possible.
8. Feature/hero summary cards may use the `surface-feature` preset, but they must stay in the same visual family as default data surfaces.
9. Standard Kai, RIA, and consent routes should use `SurfaceStack` to provide shared horizontal overscan and vertical spacing for card sections.
10. `AppPageShell` owns route start and shared page gutter. Card breathing comes from `SurfaceStack`, not from per-page inline padding hacks.
11. Outer app-facing surface shells must not rely on `overflow-hidden`; clipping is allowed only on inner media/chart/inset containers.
12. Do not stack glass-inside-glass for list managers. Row-based managers should use one outer shell and flatter rows inside it.
13. Compact density is the default for signed-in surface cards; if a route needs more space, opt into `comfortable` density explicitly instead of hardcoding larger padding at the page level.
14. On mobile, do not wrap entire routes in a passive outer card just to create breathing room. Use page gutters plus real inner surfaces.
15. Prefer flatter list/tape layouts for browse-heavy signed-in surfaces. Reserve cards for premium summaries, carousels, charts, and clearly grouped data.

### Card Depth Model

Use the `Subtle Apple` depth model:

1. Outer cards stay neutral in both light and dark mode.
2. Shared depth comes from two root tokens only:
   - `--app-card-shadow-standard`
   - `--app-card-shadow-feature`
3. Shared surface/background tokens come from:
   - `--app-card-surface-data`
   - `--app-card-surface-compact`
   - `--app-card-surface-default`
   - `--app-card-surface-surface`
   - `--app-card-surface-hero`
4. Shared border tokens exist for inner insets and grouped structure:
   - `--app-card-border-standard`
   - `--app-card-border-strong`
5. Feature emphasis belongs inside the card:
   - icon wells
   - badges
   - insets
   - copy hierarchy
6. Default outer shells are borderless glass. Do not add visible outline borders to make cards pop.
7. Do not tint outer card chrome to communicate state.
8. If a surface needs more presence, move from `surface` to `surface-feature` or `hero`; do not invent a new route-local shadow recipe.

### Ripple Ownership and Clipping

1. Every actionable shell should show Material ripple.
2. The ripple host owns clipping.
3. Rounded interactive shells must clip ripple to the exact visible radius.
4. Outer cards remain `overflow-visible`; ripple, media, code panes, and chart plots clip inside their own inner boundaries.
5. Standard shared actionables include:
   - `Button`
   - dropdown/select rows
   - segmented controls / bottom nav items
   - actionable settings rows
   - actionable cards or list rows
6. Do not add route-level ripple wrappers when a shared primitive already provides one.
7. The top shell uses `components/app-ui/shell-action-surface.tsx` as its canonical interaction host.

## Labs Boundary

1. `app/labs`, `components/labs`, and `lib/labs` are experimental.
2. Labs may inform production patterns, but they do not define the Kai shell baseline.
3. A lab pattern must graduate through accessibility, mobile, token, and verification review before it moves into stock, Morphy, or app-ui ownership.

### Cache-First Vault UX

1. Vault-backed routes should prefer cache-first rendering after unlock.
2. The standard behavior is `SWR by route/session key`:
   - render cached data immediately when valid
   - refresh silently in the background only when the cache is stale
   - dedupe in-flight refreshes
   - do not re-fetch because of unchanged token churn
3. Cache keys should be based on:
   - `userId`
   - route scope
   - source selection
   - critical params
4. Visibility and interval refreshes should be stale-aware, not unconditional.
5. Unlock warmup can seed cache, but route loaders must still own stale-refresh policy.

## Icon Policy

Rules:

1. Use Lucide icons with meaning-first selection.
2. Choose icons for what they depict, not for a vague use case:
   - use `Target`, `BarChart3`, `Building2`, `Newspaper`, `UserRound`, `Shield`, `Wallet`, etc. when they describe the surface directly
   - do not use generic `Sparkles` as a fallback for AI, optimize, onboarding, or premium semantics
3. For static app surfaces, import icons directly from `lucide-react` so tree-shaking keeps bundles tight. Do not use dynamic icon loading for normal page chrome.
4. Icon emphasis must match text emphasis in active and highlighted states.
5. Prefer relative icons that describe the section or action directly.
6. When building custom icon wells or icon-bearing surfaces, preserve Lucide’s visual assumptions:
   - 2px stroke language
   - visually centered composition
   - similar optical weight across sibling headers and actions
7. Refer to:
   - `https://lucide.dev/guide/packages/lucide-react`
   - `https://lucide.dev/guide/design/icon-design-guide`

## Market-Specific Rules

1. `RIA’s picks` uses compact list rows, not oversized cards.
2. News rows do not get a second per-row news icon when the section header already carries that meaning.
3. Market overview should only promote metrics backed by providers that are actually configured in the active environment.
4. Degraded or delayed states should read as intentional status, not as broken empty cards.
5. Long browse lists must expose backend-backed pagination metadata and use explicit browse controls once the result set stops being comfortably scannable in one pass.
6. Root browse surfaces must not rely on load-all-then-slice page contracts when the result set can grow without bound.
7. Preview widgets should prefer a shared first-page cache when they open the same underlying manager surface; use `top=n` only for dedicated preview-only fetches.
8. Empty or single-page list views must not render pagination chrome.
9. Shared paginated list primitives should provide direct page-number navigation plus optional instant list-level swipe. Do not reimplement carousel-like paging per route.

## RIA Information Architecture

1. `RIA` is a lightweight workspace shell, not a second dense operations dashboard.
2. The RIA bottom navigation is `Home / Clients / Picks / Profile`.
3. `/consents` is the single consent/request workspace for both investor and RIA personas.
4. `/ria/requests` remains only as a compatibility alias into `/consents`, not as a second consent system.
5. The shell should contextualize `/consents` as `Profile > Privacy` for breadcrumb and primary-nav highlighting while preserving `/consents` as the canonical URL.
6. Advanced PKM tools such as `PKM Agent Lab` should inherit the standard profile/privacy shell contract instead of introducing a separate hidden-route layout language.
7. Relationship views should stay grouped around:
   - relationship state
   - next action
   - available scope metadata
   - current grants
8. Workspace data views should open only after consent is active; pre-consent relationship surfaces stay metadata-only.

## Documentation References

1. `docs/reference/quality/design-system.md`
2. `docs/reference/quality/profile-settings-design-system.md`
3. `docs/reference/quality/app-surface-audit-matrix.md`
