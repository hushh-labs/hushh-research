# App Surface Design System

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document is the canonical contract for app-facing surfaces across Kai, RIA, Marketplace, Consent, and Profile.

Profile remains the reference implementation for settings rows. This document expands that language into the broader page-shell, header, and content-surface system.

## Agent Copy Ownership

The app uses the Hussh / One / Kai / Nav / KYC ontology from [../../vision/agent-ontology.md](../../vision/agent-ontology.md).

Rules:

1. Hussh is the platform and should not speak as a character in product UI.
2. One owns shared shell copy:
   - greetings
   - general empty states
   - memory framing
   - background-task notifications
   - specialist handoff copy
3. Kai owns finance copy:
   - portfolio analysis
   - market intelligence
   - investment debate
   - decision receipts
   - RIA/investor finance workflows
4. Nav owns privacy and consent copy:
   - consent requests
   - scope review
   - vault and key friction
   - deletion and revocation
   - suspicious-access or trust-state warnings
5. Route navigation action ids use `route.*`. The `nav.*` namespace is reserved for true Nav guardian actions, not navigation.
6. Email Helper owns approval-gated email replies:
   - plain-language information-needed state
   - selectable data sections
   - approval-gated drafts
   - sent-reply summaries
   - hidden workflow/writeback metadata
   - Gmail-safe plaintext and HTML generated through the shared client renderer
7. Local voice/action contracts must set `speaker_persona` to `one`, `kai`, `nav`, or `kyc` using the same ownership rules.
8. Actions executed by a specialist on behalf of One should set `delegate_agent_id` to the wired runtime specialist id while keeping public `speaker_persona` as `one`, `kai`, `nav`, or `kyc`.
9. Persona switching changes the workspace context. It does not change the top relationship agent; One stays the default shell voice.
10. Canonical app copy uses neutral voice descriptors. Do not encode celebrity references or personal numeric preferences in maintained UI copy or docs.

## Consumer Copy Contract

Persona-facing surfaces are for everyday users, not implementers.

Rules:

1. Use plain labels such as `Personal Data`, `saved details`, `sharing`, and `access`.
2. Do not expose implementation terms in consumer UI, including `PKM`, `manifest`, `schema`, `export`, `token`, `runtime`, `debug`, `dummy save`, route names, correlation ids, thread ids, workflow ids, consent ids, hashes, timings, or raw provider errors.
3. Background notifications must summarize what the user can understand or do. Diagnostics belong in logs, metadata, developer routes, or an explicit debug-only view.
4. Error copy should explain the next user action. Keep low-level failure details out of visible app text unless the route is explicitly developer-facing.
5. Route links from consumer notifications must point to consumer surfaces such as Profile, Personal Data, Access Center, or the relevant workspace, not labs or raw explorer tools.
6. Row-level saves, deletes, refreshes, and short-lived failures must use the shadcn Sonner notification stack. Do not add inline route banners for transient row actions because they shift page layout and create loading bounce.
7. Destructive actions must use the shadcn AlertDialog confirmation pattern before mutation. Keep the in-flight state inside the dialog or the initiating row action, not as a page-level loader.
8. Async actionables (deletes, resets, disconnects, sends, and any mutation that waits for a backend ack or status) must surface a single branded loading -> success/error lifecycle through `morphyToast.promise` from `@/lib/morphy-ux/morphy`, tied to the real action promise. The toast stays in its loading state while the promise is pending and morphs in place to success or error once the ack lands. Do not hand-roll a `loading` toast plus a separate `success`/`error` toast, and do not fire a success toast before the promise resolves. Pre-flight guards that are not failures of the action itself (for example a required vault unlock) stay outside the promise as an `info`/`error` toast. Use `variant: "destructive"` for destructive actionables so the toast accent matches the action.
8. Email Helper draft previews must not expose raw data structure terms such as `changes`, `entities`, hashes, provenance, parser metadata, or internal ids. Use readable sections, facts, and tables from the approved render model.
9. Dense email tables, especially portfolios and holdings, should remain complete and readable on mobile through horizontal scrolling. Do not force all table columns to fit the viewport when that creates overlap.

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

The shared app scroll root also owns bottom clearance. Standard signed-in
surfaces reserve `--bottom-chrome-stack-height`; hidden-shell and onboarding
surfaces reserve the existing Agent Bar through
`--onboarding-agent-bar-clearance`. Route content must not reposition the Agent
Bar or recreate that safe-area calculation locally. Terminal setup actions stay
in normal flow and use the shared scroll tail so their final control can be
scrolled fully above fixed chrome on compact viewports.
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
25. Top-shell menus and popovers use the shared top-shell content wrappers. They share width, collision padding, visual treatment, and mobile centering; a centered trigger must not own a route-local panel offset.
26. The Agent Bar binds to the shared bottom-chrome motion state and measures its own viewport-clear distance. Do not subscribe the voice tree to scroll frames or calculate a second route-local bottom offset.

## Pixel Grid And Symmetry Contract

Repeated visual systems must sit on explicit gridlines. Treat broken symmetry as a correctness defect, not a style preference.

Rules:

1. Section headings, progress strips, app-icon launchers, repeated tabs, and their first visible item must share the same horizontal inset inside a route section.
2. App-icon launcher cells use fixed tracks; center a finite launcher roster on a wide canvas and use `justify-start` only when it belongs to a larger, left-anchored collection. Do not stretch a small number of app icons across a wide card with `grid-cols-3 sm:grid-cols-4 ...` when that causes uneven starts.
3. The tile cell owns a stable width; the icon well, label, and status text align within that cell. Agent-roster status is expressed by its text, not a badge protruding from the icon well; the base tile geometry must remain equal across rows.
4. Content-aware tabs and dropdowns should appear only where they add navigation value. If the route body already shows the same launcher choices, hide the duplicate top selector.
5. Progress and setup strips must be full-width within the same content column and use `overflow-hidden` only on the strip itself when needed to prevent visual bleed.
6. When changing a shared visual pattern, update the owning component test to lock the layout primitive that prevents drift, such as fixed cell width, shared inset, or selector visibility.

## Agent Chat Stream Surface Contract

Agent Chat uses the portfolio import progress pattern as the canonical stream interface. The shared primitive lives in `hushh-webapp/components/app-ui/stream-progress-panel.tsx`.

Rules:

1. Active assistant stream panels use the full available chat-column width (`w-full max-w-none`). Do not cap active stream panels with the normal assistant bubble width. Completed historical assistant messages may keep a readable max width.
2. The stream surface has three distinct regions:
   - `Progress` for app-owned tool, route, stage, cancellation, and settlement events.
   - `Thinking` only for optional provider telemetry when available.
   - `Response` only for real assistant/model text from SSE `token` frames or explicit final assistant text.
3. Do not show placeholder text such as `Preparing response` inside the `Response` region. Waiting states belong to `Progress` or a small status line outside the response body.
4. Do not nest cards inside cards. The active stream panel is one flat surface; progress, thinking, marketplace opportunities, and response content are sections inside it.
5. Progress, thinking, and marketplace opportunity lists must use bounded internal scroll with `max-height`, `min-height: 0`, `overflow-y: auto`, and `overscroll-contain`. Long assistant answers use the main chat scroll, not a tiny nested response box.
6. Marketplace opportunity accordions in Agent Chat receive workspace-preloaded data. The accordion may show a lightweight loading row only while the workspace fetch is genuinely pending.
7. Mobile chat history uses the shared shell glass family (`chrome-glass-surface` / `.bar-glass` semantics) and flat bottom-nav/top-bar control recipes. Do not ship a flat white drawer or show desktop collapse controls in mobile mode.
8. Agent Chat session continuity is a surface contract: consecutive user commands reuse the active `conversationId`; reset only on explicit New chat, selecting history, user change, or vault session reset.

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
11. Standard route headers must use `PageHeader`'s `icon` slot for the leading visual by default.
12. `leading` is reserved for semantic non-icon content such as badges, avatars, or endpoint method pills; it must not be used to recreate a custom route-header icon well.
13. The chosen `accent` must match the surface identity, not the broader product parent. For example, a market workspace uses `marketplace`, not `kai`.
14. Standard mobile route headers should default to a three-row composition when they include both description and actions:

- title block
- actions
- full-width description

15. `actionsInlineMobile` is reserved for short utility headers; do not use it on primary route headers with full-width descriptive copy.
16. The three-part eyebrow/title/description composition belongs to the primary page header only. Body sections must not recreate page-header hierarchy.
17. Body section subheaders must use the shared compact section scale through `SectionHeader` or `SettingsGroup`: larger than row/body text, smaller than the page title, and independent of global `h1`/`h2` element rules.
18. Shared body section primitives must expose accessible compact headings with `role="heading"` and `aria-level`; they must not render raw `h2` elements that can inherit page-scale global heading rules.
19. Settings-style body sections may show a short eyebrow inline with the section title and one optional supporting line. They must not stack eyebrow, title, and description as three separate lines.

## Search and Filter Surface Contract

Use the shared command/search surface for app-wide agent search and route action discovery.

Rules:

1. Signed-in mode dashboards and workspaces should expose global search through `KaiCommandBarGlobal` / `KaiSearchBar`, not route-local floating search bars.
2. Route-local search is allowed only when it filters a visible local collection such as a table, receipt list, holdings list, CRM record list, or settings list.
3. Local filters must stay inside the surface they filter and must not replace the global command/search surface.
4. Persist query state only when it is part of the route contract, shareable URL, or recovery path; otherwise keep transient filter state local to the component.
5. Search empty/loading/error states should use existing list/table/surface primitives and Sonner for transient failures, not page-level banners that shift layout.
6. Mobile search overlays must respect `--top-shell-reserved-height`, bottom command chrome, and the shared scroll root; do not add raw viewport or safe-area math in route files.
7. Search inputs, command pickers, and filter controls must use shared app-ui or Morphy primitives before adding feature-local styling.

## Bottom Navigation Contract

The signed-in bottom navigation is a shared shell surface, not a route-local tab bar.

Rules:

1. The bottom utility bar is fixed and constant on all signed-in standard routes: `One`, `Profile`, and the detached `Search` command action. It does not change with agent, persona, or subroute.
2. Subroutes keep `One` selected; Profile and its children keep `Profile` selected. Search opens `KaiCommandBarGlobal`; it does not route to `/agent` or open agent chat.
3. Finance and RIA navigation belongs in the signed-in top shell, not in the bottom bar. Finance owns `Market`, `Portfolio`, and `Analysis`; RIA owns `Home`, `Clients`, and `Picks`. Tabs are driven by canonical route-tab definitions and are horizontally scrollable on small screens.
4. `Connect` is a signed-in top-bar action. It is not a bottom utility or workspace tab.
5. Use canonical route constants through `lib/navigation/app-bottom-nav.ts` and `lib/navigation/*-route-tabs.ts`; route files must not build their own shell navigation arrays.
6. The Agent Bar and bottom utility bar share the measured bottom-chrome stack with a 4px resting join. Do not add component- or route-local offsets.
7. Bottom active state uses fill and icon-color contrast. Avoid hover bounce, active icon scaling, or springy overshoot that shifts attention away from the current route.
8. Use familiar symmetric icons for global anchors. Agent/search entry points should read as search or conversation access, not decorative sparkle automation.
9. The pending-consent count belongs on the One utility only; never duplicate it onto Profile or a workspace tab.

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

## Route Loading Contract

1. Cold App Router segment fallbacks use `RouteLoadingState` from
   `components/app-ui`, choosing `app`, `onboarding`, or `ambient` shell
   geometry. Do not use a route-local blank or centered-text fallback.
2. `HushhLoader` remains for transition-only and action-local status. Route
   transitions and cold guards use a compact labeled loading indicator, not
   skeleton cards that replace a usable app surface.
3. A safe warm or stale cache render remains visible during refresh. A fallback
   must never replace it with a page-wide loader, and it must never expose
   protected or vault-backed content before the existing guards settle.

## Control Surface Contract

The agent bar, bottom nav, and top-app-bar action buttons define the gold-standard flat-control aesthetic. All standalone buttons, pill triggers, and icon controls should match it.

Rules:

1. `ShellActionSurface` (`components/app-ui/shell-action-surface.tsx`) is the canonical control primitive. It exports `SHELL_ICON_BUTTON_CLASSNAME` and `SHELL_PILL_TRIGGER_CLASSNAME` and embeds `MaterialRipple variant="blue" effect="glass"`. Reuse these instead of re-deriving the recipe per surface.
2. The flat-control recipe is: `rounded-full` shape, base fill `bg-black/[0.05] dark:bg-white/[0.07]`, hover fill `hover:bg-black/[0.08] dark:hover:bg-white/[0.1]`, press feedback `active:scale-90` for icon controls and `active:scale-[0.97]` for pill controls, and `transition-[color,background-color,transform] duration-200`. Do not add visible borders, drop shadows, or per-control backdrop blur to flat controls.
3. Icon controls use `h-9 w-9` and color contrast (`text-muted-foreground hover:text-foreground`). Pill controls use `h-9 px-3.5 text-[14px]` with platform text color (`text-[#1d1d1f] dark:text-[#f5f5f7]`).
4. When using `morphy-ux` `Button`, a flat control maps to `variant="none" effect="fade"`. Do not mix `effect="glass"` and `effect="fade"` between sibling controls in the same group. The vault unlock methods (Vault Key, Passkey, Recovery Key) must all share one effect so the buttons read as a uniform set.
5. Bars use the shared `.bar-glass` and `.bar-glass-top` surfaces; cards use the `--app-card-*` tokens. Controls live on top of those surfaces and stay flat.
6. Focus state is the shared Foundation ring `focus-visible:ring-2 focus-visible:ring-accent/70` (gold, theme-aware via the accent token). Do not invent per-control focus styling and do not reintroduce off-palette `ring-sky-*`/`ring-blue-*`.

## Foundation Color Contract

The app's color identity is the **Foundation** system with ONE switchable
accent. The `--app-accent-*` family in `hushh-webapp/app/globals.css` is the
single accent source of truth: **iOS Blue by default**, **Molten Gold** when
the user opts in (Profile → Preferences → Accent; persisted at
`hushh.app.accent.v1`, applied pre-paint via `html[data-accent="gold"]` by the
inline script in `app/layout.tsx`, managed by `lib/theme/accent.ts`). All
legacy accent names (`--foundation-gold-*`, `--color-accent-*`, `--brand-*`,
`--morphy-primary-*`, `--tone-blue*`, `--accent`, `--ring`) alias the family
and flip automatically in `.dark`, so existing consumers follow the preference
with zero churn. RIA compatibility aliases resolve through this same family;
RIA must not override the shared shell or impose a separate persona palette.
This contract governs how the tokens are USED in component code.

### The Foundation law

1. **Accent is emphasis ONLY — never decoration and never primary.** Ink
   (near-black, `--primary`/`text-foreground`) carries primary; gray
   (`text-muted-foreground`) carries support. The accent marks the ONE thing
   that deserves attention on a surface (active state, key metric, brand chrome).
2. **Use semantic tokens, not raw hex.** Prefer `text-accent-strong`,
   `bg-accent`, `bg-accent-surface`, `border-accent-border`, `ring-accent`, or
   the neutral family directly (`text-[color:var(--app-accent)]`,
   `bg-[color:var(--app-accent-tint)]`, `text-[color:var(--app-accent-deep)]`,
   …) over literal accent hexes. Raw hexes break BOTH dark mode and the accent
   preference; `npm run verify:accent-tokens` fails the build on them.
3. **`text-accent-strong` / `--app-accent-deep` already flip for dark.** Use
   them WITHOUT a `dark:` variant — adding one fights the token.
4. **No off-palette accent colors.** `blue-*`, `sky-*`, `indigo-*`, `cyan-*`
   Tailwind classes and hardcoded hexes from either accent palette are NOT
   allowed as brand accent in component source. New code consumes the token
   family; the enforcement script allowlists only `globals.css`, the static
   Foundation reference, absence tests, and two documented runtime exceptions.
5. **Token roles:** `--app-accent` = solid fills/CTAs, `--app-accent-deep` =
   text/icons on light (bright partner on dark), `--app-accent-bright` =
   gradient/dark partner, `--app-accent-tint`/`-surface`/`-surface-strong` =
   fills, `--app-accent-border`/`-ring` = hairlines and focus, `--app-accent-fg`
   = text on solid accent, `--app-accent-hero-*` = hero gradient stops.

### Brand-accent vs semantic-status (the one rule that governs every color sweep)

When removing off-palette color, every usage is EITHER brand chrome (→ accent
tokens) OR a semantic status/data-viz color (→ LEAVE IT). Accent-ifying a status
color actively breaks the color language (e.g. under the gold accent it would
collide with the amber/warning semantic).

- **Brand accent → ACCENT TOKENS:** buttons, links, active tab/indicator, focus
  ring, brand gradient, a lone decorative panel/icon accent, a category "info"
  chip that is NOT part of a status set.
- **Semantic status / data-viz → LEAVE:** an "info" state sitting in a
  success(green)/warning(amber)/error(red) set, a distinct chart-series color,
  bullish/bearish/neutral, a tier/persona category color, an
  in-progress/refreshing status (sky paired with emerald=done/rose=failed).
- **The fast tell:** look at what the color is grouped WITH in the same
  map/ternary/object. Grouped with emerald+red+amber → STATUS → leave. The only
  accent on a header/icon/border/active-indicator, or paired with category chips
  → BRAND CHROME → accent tokens. When unsure, LEAVE a clearly-semantic status
  color: a missed brand accent is cosmetic, an accent-ified status color is a
  broken semantic.

### Mapping cheat-sheet

| Off-palette (from) | Foundation (to) |
|---|---|
| `bg-blue-50`, `dark:bg-blue-950/40` | `bg-accent-surface` (no `dark:` needed) |
| `text-blue-500/600/700` | `text-accent-strong` |
| `bg-blue-500/600` accent fill | `bg-accent` (gold) — OR `bg-primary` (ink) if it's a PRIMARY CTA |
| `hover:bg-blue-600` | `hover:opacity-90` |
| `border-blue-*` | `border-accent-border` |
| `ring-blue-*`, `focus:ring-blue-*` | `ring-accent` / `focus-visible:ring-accent/70` |
| `from-blue-500 to-purple-600` brand gradient | `from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)]` |
| brand hex `#0071e3`/`#0066cc` (+ dark `#0a84ff`/`#2997ff`) | `text-[color:var(--app-accent-deep)]` text / `bg-[color:var(--app-accent)]` fill |

NOTE: `MaterialRipple variant="blue"` and the `morphy-ux` `gradients.primary`
already resolve to `var(--morphy-primary-*)` (gold) — these are legacy NAMES, not
off-palette bugs; leave them unless renaming the whole API.

### Verification + reporting for a color sweep

1. Find hits: `rg -n -e 'blue-[0-9]' -e 'sky-[0-9]' -e 'indigo-[0-9]' -e 'cyan-[0-9]' -e '#0071e3' -e '#0066cc' -e '#3b82f6' <files>`.
2. Edit with exact string replacement; colors only — never touch layout, spacing,
   logic, or copy.
3. Gate a className-only sweep with `npx tsc --noEmit` (exit 0, your files clean).
   `npm run build` is NOT needed for color strings (it needs backend env). Do NOT
   touch `app/globals.css` during a component sweep — the tokens are already done.
4. Report per file: what you CHANGED, what you deliberately LEFT and WHY (name the
   status set it belongs to), and any genuine uncertainty. A report that lists only
   changes is incomplete — the LEFT list with semantic justification is the proof
   judgment was applied rather than blind find-replace.

The component-level playbook with the full CHANGED/LEFT catalog from the
`components/kai/**` finance sweep lives in the `hushh-workspace-and-governance`
skill at `references/foundation-design-system.md`.

## Overlay Backdrop Contract

Every floating surface that takes modal focus shares one backdrop language so opening a surface gives the same dimming and blur thump.

Rules:

1. The canonical scrim is `bg-black/22 backdrop-blur-[8px]` plus the `-webkit-backdrop-filter` fallback, sitting at `z-[499]` directly below the surface at `z-[500]`. Radix overlays (`DialogOverlay`, sheet, drawer, alert dialog) already carry this via their `data-state` motion classes.
2. Dialogs, sheets, drawers, the command palette, and contextual vault unlock prompts inherit the scrim through `DialogOverlay`; do not add a second hand-rolled scrim on top. Every vault unlock sheet suppresses persistent top chrome, bottom navigation, and the Agent Bar while it is open. The non-dismissible `VaultLockGuard` is the credential-gate exception: its drawer uses one opaque theme canvas without blur or backdrop fade, so route chrome and Agent Bar are fully covered rather than visibly competing beneath an unlock form.
   Passkey or biometric enrollment is an explicit choice within vault setup or Security; never auto-open that prompt merely because a person navigated to a signed-in route.
3. Popovers that take modal focus opt into the same backdrop with `PopoverContent withBackdrop`. The scrim renders as `data-slot="popover-scrim"` and animates through the shared `overlay-scrim-in` / `overlay-scrim-out` keyframes registered in `globals.css`. Do not hand-roll a popover scrim with ad hoc opacity or blur values.
4. Scrim animation tokens (`--motion-overlay-*`) are shared. Do not override per-surface enter/exit durations, and honor the reduced-motion media query already wired in `globals.css`.
5. Non-modal helper popovers (tooltips, inline hint bubbles, hover cards) do not take a backdrop. Reserve `withBackdrop` for surfaces that should pull focus away from the page.

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
9. Analysis/workspace sections should avoid duplicate summary chrome. Use one primary card for the main read and then secondary cards only when they add new information.

### Information Density And Evidence

1. Concrete detail beats vague summary.
2. If a surface says `44 names`, the detail state should reveal the names cleanly.
3. Counts are only useful when they open into inspectable evidence.
4. One idea per card. Do not mix primary read, secondary status, and supporting explanation in the same card unless the grouping is essential.
5. Avoid stacked framing chrome:
   - header inside header
   - card inside card without semantic separation
   - repeated helper copy above and inside the same module
6. Text grouping must communicate meaning, not just fit data. Avoid arbitrary line-broken symbol dumps and vague “read” summaries when clearer structured presentation is available.
7. Modals and control surfaces should be information-dense, focused, and interaction-smooth:
   - narrower than full page shells by default
   - content remains mounted through close animation
   - close affordances stay tactile and reliable
8. Responsive composition is not width-only responsiveness. Recompose boards for tablet and desktop instead of stretching mobile stacks.
9. Persona-facing surfaces should bias toward shorter, clearer, more descriptive copy over decorative narrative.
10. The design system should challenge poor UX proactively; weak hierarchy, vague detail, or obvious asymmetry should be treated as design defects, not stylistic preferences.
11. Voice or agent-aware controls must not advertise executable action ids unless the generated gateway can execute or route them. If a control is local-only, coming soon, incompatible on the route, or not wired to the gateway, show it as state/context only and omit the executable action id.

### Ripple Ownership and Clipping

1. Every actionable shell should show Material ripple.
2. The ripple host owns clipping.
3. Rounded interactive shells must clip ripple to the exact visible radius.
4. Outer cards remain `overflow-visible`; ripple, media, code panes, and chart plots clip inside their own inner boundaries.
5. Standard shared actionables include:
   - `Button`
   - `AlertDialogAction` / `AlertDialogCancel` (confirmation buttons)
   - dropdown/select rows
   - segmented controls / bottom nav items
   - actionable settings rows
   - actionable cards or list rows
6. Do not add route-level ripple wrappers when a shared primitive already provides one.
7. The top shell uses `components/app-ui/shell-action-surface.tsx` as its canonical interaction host.
8. Confirmation buttons get their ripple from the shared `components/ui/alert-dialog.tsx` primitive: `AlertDialogAction` and `AlertDialogCancel` host a clipped `MaterialRipple` (palette mapped from the shadcn variant) while preserving their appearance via the caller `className` (for example `app-critical-action`). Do not re-import the plain `@/components/ui/button` for confirmation actions or strip the ripple host; keep the action label inside the `z-10` content span so the ripple stays behind it.

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
6. New or changed screens must stay covered by `cd hushh-webapp && npm run audit:cache-coherence`.
7. Performance is part of the UX contract:
   - use the safest available render path before showing a blocking loader
   - preserve stale safe content while refresh runs
   - avoid bounce or blank reload effects when a warm snapshot exists
   - emit bounded route/cache KPI metadata for route readiness and refresh outcomes
8. Cache and performance events must be consumer-safe metadata only. Never log raw user values, PKM payloads, workflow IDs, portfolio values, prompts, or cache keys.
9. If a route cannot render from cache safely, the loading state must explain the real user-facing reason, such as locked vault, first setup, or reconnect needed.

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
2. RIA workspace navigation lives in the top shell: `Home / Clients / Picks`. The fixed bottom utilities remain `One / Profile / Search`.
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
9. Persona-facing profile copy should use plain-language terms such as `Personal Data`; keep `PKM` for developer-only surfaces.
10. Profile-family vault actions should live in the shared top app bar instead of route-local hero chrome.
11. Settings/menu group treatment should stay compositionally consistent from mobile through desktop rather than switching into a separate desktop card language.

## Documentation References

1. `docs/reference/quality/design-system.md`
2. `docs/reference/quality/profile-settings-design-system.md`
3. `docs/reference/quality/app-surface-audit-matrix.md`
