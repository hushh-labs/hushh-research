# Profile reference (canonical measured specification)

The approved Profile design, measured from production CSS and a real browser. This
file is the only place measured values live. `SKILL.md` links here and repeats none of
them. Keep it stable: change it only when the user explicitly asks for a reference update
(then re-measure, bump the date and commit below).

This reference supersedes earlier Blinkit/Apple typography targets for Connect and Feed.

## 1. Provenance

| Item | Value |
|---|---|
| Measured | 2026-10-18 |
| Branch / commit | `claude/profile-ui-skill-reference-e8a165` at `b2ff5e366c` (identical to `main`, PR #8182 merge) |
| Surface | Profile pane (`ProfilePane` sheet, home screen) plus one detail screen ("Your account" stack) |
| Source components | `components/app-ui/profile-pane.tsx`, `components/app-ui/settings-ui.tsx` (`SettingsGroup`, `SettingsRow`), `components/app-ui/typography.tsx`, `components/profile/profile-workspace-page.tsx` (`profileRootContent`, lines ~4832-5043), `components/profile/profile-pane-icons.tsx`, `components/profile/profile-your-account-icons.tsx`, `components/profile/profile-stack-navigator.tsx` |
| Style source | `hushh-webapp/app/globals.css` (all `.profile-*`, `--app-side-pane-*`, the final `@layer base` block at lines 9220-9346) |
| Browser | Playwright Chromium (headless), light scheme, reduced motion, device scale factor 2 |
| Inspection viewports | 320, 390, 393, 430, 768, 1280 px wide, 900 px tall (home); 430 px (detail screen) |
| Font | Plus Jakarta Sans; only 400, 600, 700 faces ship. Faces confirmed with CDP `CSS.getPlatformFontsForNode`, not `document.fonts.check`. |

**What was real and what was stood in.** The harness bundles the production `ProfilePane`,
Sheet, `SettingsGroup`/`SettingsRow`, the Profile icon components, `AppPageShell` regions,
`ProfileStackNavigator` and the full compiled `globals.css` with Tailwind. Stand-ins: routing,
the vault gate, the avatar editor, and the Profile workspace root. The root repeats
`profileRootContent` (same classes, groups and row order), minus data hooks. Computed
values below come from that mount.

**Live-session check not done.** `/one` needs a Firebase sign-in that an agent must not
perform. Cross-check instead against the clean screenshot (850px wide, 2x): "Profile" is 117
device px and the email 451 device px in both the screenshot and the harness, and the identity
name is 1.25x wider than the 19px render, which is the 24px case (viewport 600px or wider).
Re-verify in a signed-in session with the probe in section 10.

## 2. Role table

| Reusable role | Profile example | Team alias | Owner in code |
|---|---|---|---|
| Surface header | "Profile" | header | `SheetTitle` in `profile-pane.tsx`, styled by `.profile-pane-header` + base-layer block |
| Header description | "Your account, preferences, and privacy controls." | header supporting text | `SheetDescription` |
| Identity name | "Parth Mawai" / "Sharu Khan" | identity | `h1.profile-home-name.ui-text-identity-name` |
| Identity meta | email beside provider mark | identity supporting text | `.profile-home-meta` |
| Section subtitle / group label | "Your settings", "Legal", "Account access" | substitute | `SettingsGroup title=` → `[data-slot="settings-group-heading"]` |
| Primary navigation-row label | "Your account" | nudging / CTA | `SettingsRow title=` → `[data-slot="settings-row-title"]` |
| Row description | "Google Workspace and finance connections" | supporting text | `SettingsRow description=` → `[data-slot="settings-row-description"]` |
| Leading icon | Account, bank, tag, wallet... | icon | `profile-pane-icons.tsx`, `profile-your-account-icons.tsx` |
| Trailing chevron | caret at the row end | chevron | `CaretRightIcon` inside `SettingsRow chevron` |
| Horizontal divider | line between rows, line under header | Hr | row `::after`; header `border-bottom` |
| Vertical divider | none implemented | Vr | not present; see 6 |

The team's "nudging/CTA" label is a navigation row label, not a button. Sharing its
typography must not turn static text into something that looks tappable.

## 3. Typography (home screen, light scheme)

All text is Plus Jakarta Sans, `font-family: var(--font-app-body)` (display family for
headings, same face). Sizes are authored in px. Colors resolved to sRGB on the pane
background `#f2f2f7`.

| Role | Size | Authored weight → painted face | Line height | Letter spacing | Color (token → value) | Spacing / wrapping |
|---|---|---|---|---|---|---|
| Surface header | 20px | 600 → SemiBold | 1.15 (23px) | -0.025em (-0.5px) | `--ios-account-label` → #1d1d1f | Root: single line, `truncate`. Detail: centered, wraps, `text-wrap: balance`. Header padding 20px 68px 15px 20px |
| Header description | 12px | 400 → Regular | 1.4 (16.8px) | normal | `--ios-account-secondary-label` → #7f8083 (3.54:1) | Wraps naturally (2 lines at 320px). 4px gap under title. `sr-only` on detail screens |
| Identity name | `clamp(19px, 4vw, 24px)`: 19px below 475px viewport, 24px from 600px | 600 → SemiBold | 1.1 (20.9px / 26.4px) | -0.045em (-0.86px / -1.08px) | #1d1d1f | `overflow-wrap: anywhere`; driven by viewport width, not pane width |
| Identity meta (email) | 13px | 400 → Regular | 18px | normal (0) | #6e6e73 (4.54:1) | 6px gap, 14px provider mark; wraps `anywhere` (2 lines at 320px) |
| Section subtitle / group label | 10px | 600 → SemiBold | 14px | 0.02em (0.2px) | `--ios-account-secondary-label` → #7f8083 (3.54:1) | No uppercase. Padding-inline 6px. Margin 0 above the first group, 10px above later groups, 5px below |
| Primary nav-row label | 13px | token 550 → **SemiBold (600 face)** | 1.2 (15.6px) | normal | `--ios-account-label` → #1d1d1f (15.07:1) | `overflow-wrap: anywhere`, wraps, row grows past its 43px minimum |
| Row description | 9px | 400 → Regular | 1.2 (10.8px) | normal | #7f8083 (3.54:1) | 2px under the label, wraps `anywhere` |

Token references that already exist (reuse, do not restate):

| Role | Existing token or class |
|---|---|
| Section subtitle | `--app-side-pane-section-size` 10px, `-line` 14px, `-weight` 600, `-tracking` 0.02em |
| Nav-row label | `--app-side-pane-row-title-size` 13px, `-line` 1.2, `-weight` 550 |
| Row description | `--app-side-pane-row-description-size` 9px, `-line` 1.2 |
| Row spacing | `--app-side-pane-row-inset` 6px, `--app-side-pane-row-gap` 5px |
| Colors | `--ios-account-label`, `--ios-account-secondary-label`, `--ios-account-accent`, `--profile-pane-hair` |
| Semantic components | `RowLabel`, `RowDescription`, `SectionLabel`, `PageSubtitle` in `components/app-ui/typography.tsx` (these carry the app-wide scale, not the Profile scale) |

Roles with no token yet (values live only as CSS literals): surface header (20 / 1.15 /
600 / -0.025em), header description (12 / 1.4), identity name, identity meta. Add tokens for
them only when the first page migration needs them, and without rewiring Profile's own rules.

## 4. Icons and chevron

| Property | Value |
|---|---|
| Family | Bespoke line icons, not Phosphor/Lucide. `PaneIcon` (`profile-pane-icons.tsx`) and `AccountIcon` (`profile-your-account-icons.tsx`, used for Payouts and Request pricing) share one recipe: viewBox 24, `fill="none"`, `stroke="currentColor"`, round caps and joins |
| Size | Home: 22x22 well and 22px svg. Detail screens: 24px |
| Stroke width | Home: 1.65 (user units, about 1.5px on screen at 22px), forced by `[data-slot="settings-row-icon"] svg` at `globals.css:8222-8224`. Detail: 1.8 |
| Color | Strokes `--ios-account-label` (#1d1d1f). One accent part per icon in `--ios-account-accent` (#007aff): stroke class `profile-pane-icon-accent`, or fill class `profile-pane-icon-accent-fill` for the Appearance dots. Destructive row: whole icon #ff3b30 |
| Treatment | `iconTone="capability"`: transparent well, no tile, no radius, no shadow |
| Alignment | Icon starts 6px from the row's left edge; 5px gap to text; text starts 33px from the row edge; icon centered vertically (`self-center`) |
| Chevron | Phosphor `CaretRightIcon`, 15px home / 14px detail, `--ios-account-secondary-label` at opacity 0.68, 8px from the row's right edge |

The "Sign out" row is destructive only in its icon. Its label stays #1d1d1f in the pane, because
the base-layer row rule sets color with `!important`.

## 5. Layout rhythm

5.1 Pane: width `min(430px, 100vw - 2 x gutter)`, gutter `clamp(12px, 2.5vw, 18px)`; radius 25px;
height `min(820px, available)`.
5.2 Header bar: border-bottom 1px `--profile-pane-hair`. Close button 44px circle, `top: 20px; right: 20px`,
fill `rgba(255,255,255,0.24)`, X icon 16px.
5.3 Identity hero: avatar 44px (56px outside the pane), 13px gap, padding `15px 4px 12px`.
5.4 Rows: min-height 43px (all 43px at every width, single line), padding 6px, gap 5px.
Group block: 10px above the heading, 14px heading, 5px below (29px between a group's last row
and the next group's first row).
5.5 Group shell on home: transparent, radius 15px, no border or shadow. Rows have 12px radius.

## 6. Dividers

| Divider | Orientation | Treatment |
|---|---|---|
| Between rows | Horizontal | Row `::after`, authored height 0.5px, `--profile-pane-hair` (`rgba(36,43,52,0.12)`, paints #d9dadf on the pane), `left: 37px`, `right: 6px`, hidden on each group's last row. **Rendered thickness: 1 CSS px in Chromium at 1x, 2x and 3x** (1, 2 and 3 device pixels), so the 0.5px authoring does not produce a half-pixel line |
| Under the header | Horizontal | `border-bottom: 1px solid var(--profile-pane-hair)`, full pane width |
| Detail screen rows | Horizontal | Same hair color, `left: 0; right: 0` (full width of the card) |
| Between groups | none | Spacing only (section 5.4) |
| Vertical | **none implemented** | The gray vertical bar at the right edge of the annotated screenshot is the OS overlay scrollbar of `.profile-pane-scroll-root`; the app does not style it |

## 7. Detail-screen variant ("Your account" and other stack screens)

Different from home. Stack content (`[data-profile-stack-content="true"]`) takes its sizes from the
final base-layer block (`globals.css:9283-9345`):

| Role | Size | Weight → face | Line height | Color |
|---|---|---|---|---|
| Group label | 10px, 0.02em | 600 → SemiBold | 14px | #7f8083 |
| Row label | 13px, tracking 0 | 400 → Regular | 1.22 (15.9px) | #1d1d1f |
| Row description | 12px | 400 | 1.3 (15.6px) | #7f8083 |
| Trailing value | **15px measured** (pane rule says 12px/1.3) | 400 | 20px | #8e8e93 |
| Inputs, selects, placeholders | 13px (from CSS, not rendered) | 400 | 1.3 | n/a |

Geometry: row min-height 58px, padding-inline 14px (10px when viewport <= 440px), icon 24px,
chevron 14px, card radius 17px with 1px `rgba(255,255,255,0.38)` border and `rgba(255,255,255,0.78)` fill.

## 8. Cascade authority (read before copying values)

The values above are what the browser computes, and they differ from the first literals a reader
meets in `globals.css`. Important declarations in an earlier `@layer` beat unlayered
`!important`. The pane's final `@layer base` block therefore wins, and these literals are dead:

| Dead literal | Where | Winner |
|---|---|---|
| `font-weight: 700` on the sheet title | `globals.css:2488` | 600, base block 9228 |
| `font-size: 22px`, `line-height: 27px` on the name | `1967-1974` | clamp 19-24px, 1.1, base block 9233-9236 |
| `font-weight: 500` on row titles | `2790` | token 550, base block 9261 |
| `font-size: 10.5px; line-height: 1.3` on identity meta | `2608-2612` | helper-text tokens via the `text-xs` catch-all (`globals.css:8669`), 13px/18px |
| `font-size: 13px` on the Tailwind classes in `profile-pane.tsx:247` (`text-[22px] font-bold leading-[27px]`) | component | base block |

Consequences for any page that wants these roles: write the rule inside `@layer base`, with
`!important` and higher specificity than `[data-slot="settings-row-title"]` and the other
global role rules, or it will lose silently. Confirm the winner with computed style.

Font note: weight 550 snaps to the SemiBold (600) face; 500 snaps to Regular; 800 to Bold.
There is no Medium face, so a spec that says 500 paints 400.

## 9. Discrepancies and unresolved measurements

1. **Trailing value on detail screens**: the pane rule says 12px/1.3 for
   `[data-slot="settings-row-trailing"]`, but the inner `TrailingValue` keeps its own role class and measures 15px/20px. Profile
   disagrees with itself; do not copy either value without asking.
2. **Dark scheme not measured.** Colors are token-based and flip under `.dark`; sizes and spacing
   are scheme-independent in the CSS, but no dark computed values were captured. The pane
   also forces `color-scheme: light` on its sheet.
3. **WebKit / iOS rendering not measured.** The 0.5px divider and the text rasterizing are
   Chromium results only.
4. **Live signed-in Profile not inspected** (see section 1). Screenshot cross-check only.
5. **Small sizes.** 9px description and 10px group label sit below common readability
   guidance (secondary text also reaches only 3.54:1). They are the approved reference, so they are
   recorded as-is; flag them in every migration report and test 200% enlargement.
6. **Name size is viewport-driven.** A 430px pane in a 1280px window shows the 24px name; the
   same pane in a 430px window shows 19px.
7. Annotated screenshot reads as the same layout at about 1.5x display scale (393 CSS px wide); its sizes are consistent
   with the 19px name case.

## 10. Live probe (paste in DevTools on a signed-in Profile pane)

```js
const q = (s) => document.querySelector(s);
const f = (el) => { const c = getComputedStyle(el); return [c.fontSize, c.fontWeight, c.lineHeight, c.letterSpacing, c.color].join(" | "); };
({
  header: f(q('.profile-pane-header [data-slot="sheet-title"]')),
  headerDescription: f(q('.profile-pane-header [data-slot="sheet-description"]')),
  name: f(q('.profile-home-name')),
  email: f(q('.profile-home-meta > span:last-child')),
  groupLabel: f(q('[data-slot="settings-group-heading"]')),
  rowLabel: f(q('[data-slot="settings-row-title"]')),
  rowDescription: f(q('[data-slot="settings-row-description"]')),
  divider: (({ height, left, right }) => ({ height, left, right }))(getComputedStyle(q('[data-testid="settings-row"]'), '::after')),
});
```

Expected at a 430px-wide window: header `20px | 600 | 23px | -0.5px`, group label `10px | 600 | 14px | 0.2px`,
row label `13px | 550 | 15.6px | normal`, row description `9px | 400 | 10.8px`.
