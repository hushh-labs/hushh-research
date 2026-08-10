# UAT Apple iOS-First Visual Audit

Status: Phase 1 audit baseline.

Scope: `hushh-webapp/app`, `hushh-webapp/components`, and `hushh-webapp/lib`.

Source contract:

- `C:\Users\jhumm\Downloads\APPLE-IOS-FIRST-PRODUCT-DESIGN-SYSTEM-v2 (1).md`
- `C:\Users\jhumm\Downloads\CODEX-UAT-ALL-SCREENS-MIGRATION-PROMPT (3).md`
- `C:\Users\jhumm\Downloads\CODEX-GLOBAL-HIERARCHY-SPACING-AUDIT-PROMPT.md`

Migration boundary:

- Preserve all visible content, data, row order, route behavior, forms, permissions, validation, and API calls.
- Exclude Welcome from this migration unless a later task explicitly includes it.
- Normalize shared tokens/components before route-specific page polish.
- Treat UAT as the reference and promotion target. Local verification comes first.

## Visual Context

Canonical visual owner: [Quality and Design System Index](../reference/quality/README.md).

This audit identifies where current visual decisions live so the migration can normalize shared tokens and components before route-specific polish.

## Audit Summary

The current product has enough shared primitives to migrate centrally, but visual rules are still scattered across global CSS, Morphy utilities, agent icons, Kai surfaces, and One Location surfaces.

Mechanical scan baseline:

| Category | Matches |
| --- | ---: |
| Font-family/font utility overrides | 59 |
| Heavy font-weight signals | 135 |
| Uppercase/tracking/letter-spacing signals | 667 |
| Hardcoded hex colors | 1608 |
| `rgb`/`rgba`/`hsl` color literals | 403 |
| Gradient/background-image signals | 481 |
| Shadow/drop-shadow signals | 613 |
| Backdrop/blur/glass signals | 506 |
| Large arbitrary radius signals | 51 |
| Fixed/viewport-height signals | 239 |
| Z-index signals | 196 |

These counts are not all defects. They identify where the Apple-system migration must be reviewed and centralized.

## Highest-Risk Files

| File | Why it matters |
| --- | --- |
| `hushh-webapp/app/globals.css` | Owns global tokens, canvas, typography, glass, Profile/Account polish, and many color/shadow/background rules. |
| `hushh-webapp/lib/morphy-ux/utils.ts` | Contains dense visual material utilities with gradients, shadows, blur, and hardcoded colors. |
| `hushh-webapp/app/one/location/page.tsx` | High concentration of hardcoded color, radius, shadow, viewport, and map-adjacent styling. |
| `hushh-webapp/components/one-location/onboarding/one-location-onboarding-flow.tsx` | Many hardcoded colors, weights, z-index values, and screen-flow layout rules. |
| `hushh-webapp/components/one-location/onboarding/save-location-modal.tsx` | Modal styling has many local colors and shadow decisions. |
| `hushh-webapp/components/app-ui/agent-section-icon.tsx` | Agent color identity is duplicated in component-local maps instead of a single registry. |
| `hushh-webapp/lib/morphy-ux/card.tsx` | Card material currently leans into gradients, blur, and shadow; standard content cards should be opaque and shadowless. |
| `hushh-webapp/app/marketplace/page.tsx` | Uses uppercase/tracking and visual effects that need archetype review. |
| `hushh-webapp/components/kai/views/*` | Finance/data surfaces include several local material, shadow, and responsive rules. |
| `hushh-webapp/components/agent/agent-chat-workspace.tsx` | Chat/assistant surface has local typography/material/layout rules that should map to shared chat primitives. |

## Token Gaps

Required shared tokens to normalize or verify:

- Canvas: `--app-canvas: #f2f2f7`.
- Surfaces: `--surface-primary`, `--surface-secondary`.
- Labels: `--label-primary`, `--label-secondary`, `--label-tertiary`, `--label-quaternary`.
- Separators and fills: `--separator`, `--separator-soft`, `--fill-primary`, `--fill-secondary`, `--fill-tertiary`.
- Semantic system colors: blue, green, red, orange, yellow, pink, purple, indigo, teal, cyan, mint.
- Spacing scale: 4px base with 8px structural rhythm.
- Radius scale: icon, control, input, card, large-card, sheet, pill.
- Motion scale: fast, standard, sheet.
- Functional glass: one reusable material only for navigation, controls, overlays, and accessory bars.

## Typography Findings

Current risks:

- Several files use local font-family declarations or hardcoded font utility classes.
- Heavy weights appear outside clear identity/title use cases.
- Uppercase and tracking utilities appear broadly, including ordinary section labels and compact metadata.
- Some existing negative tracking appears in shared components. The migration should avoid adding new negative letter-spacing because the active repo UI guidance requires letter spacing to stay neutral.

Migration target:

- Inter Variable only.
- Weights limited to 400, 500, 600, 700.
- Meaningful text no smaller than 13px.
- Settings rows use 17px body/headline scale.
- Desktop increases surrounding whitespace, not component scale.

## Surface Findings

Current risks:

- Standard cards and list panels frequently use gradients, shadows, blur, or decorative backgrounds.
- Some global and page-level backgrounds include dotted/noise/mesh-like visual treatments.
- Glass-like material is used beyond functional controls.

Migration target:

- Standard content cards are opaque white and shadowless.
- Canvas is calm `#f2f2f7` unless the screen is map, camera, chart, media, or document content.
- Functional glass is reserved for navigation, floating controls, bottom tab, Talk to One, composer, popovers, sheets, and overlays.

## Icon And Color Findings

Current risks:

- Agent color values exist in both `one-capabilities.ts` and `agent-section-icon.tsx`.
- Profile launcher palette is local to `AgentSectionIcon`.
- Ordinary settings rows risk becoming either too colorful or too faded if they do not use a shared neutral icon contract.

Migration target:

- One central agent theme registry.
- Peer settings/account icons stay neutral unless the row is a real brand/service or semantic action.
- System blue remains interaction.
- Green, red, orange/yellow are semantic only.
- Agent accent identifies the agent; it does not tint full pages, every button, or every card.

## Responsive Findings

Current risks:

- Viewport-height and fixed-position signals are widespread.
- Some route layouts may be validated in desktop responsive mode only, not iOS Safari behavior.
- Bottom controls require content clearance checks because Talk to One and the tab bar can overlap long content.

Migration target:

- Validate the required widths from the design-system file.
- No horizontal document overflow.
- Safe-area support for top, side, and bottom fixed/floating controls.
- Keyboard-aware forms and chat composer behavior.
- Settings/account columns stay constrained on desktop.

## Shared Primitive Worklist

Implement or normalize centrally before broad page polishing:

- `AppShell`/content scroll spacing and safe-area clearance.
- `TopNavigationBar` back/title/action grammar.
- `PageHeader`, `IdentityHeader`, and `AgentHeader`.
- `GroupedCard`, `SettingsRow`, `SectionLabel`.
- `AgentIconTile` and `CategoryIconTile`.
- Button variants, form fields, segmented controls, search fields, status badges.
- Empty, loading, error, sheet, dialog, toast, and bottom accessory primitives.

## Shared Hierarchy Pass Outcome

The current pass installed shared role primitives and wired the highest-leverage components first:

- `hushh-webapp/components/app-ui/typography.tsx`
- `hushh-webapp/components/app-ui/page-sections.tsx`
- `hushh-webapp/components/app-ui/settings-ui.tsx`
- `hushh-webapp/components/ui/field.tsx`
- `hushh-webapp/components/ui/button.tsx`
- `hushh-webapp/components/app-ui/top-shell-tabs.tsx`
- `hushh-webapp/components/app-ui/top-app-bar.tsx`
- `hushh-webapp/lib/morphy-ux/tokens/surfaces.ts`
- `hushh-webapp/app/globals.css`

`npm run typecheck`, `npm run verify:design-system`, `npm run verify:cache`, `npm run verify:docs`, and `npm run lint` passed after these shared changes. `npm run verify:routes` is blocked locally by missing maintainer-only reviewer identity values, so rendered route proof remains pending.

## Phase 1 Outcome

Route inventory exists in `docs/ui-migration/route-matrix.md`.

No route is visually complete yet. A route can move to complete only after local rendered verification covers mobile, tablet, desktop, iOS Safari or equivalent device proof, functional behavior, and content preservation.
