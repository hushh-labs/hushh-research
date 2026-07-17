# Hussh Frontend Design System


## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

The cross-layer visual, shell, material, and AX rules are maintained in
[One UX and AX Design Contract](./design.md). This document owns implementation
layering and primitive placement beneath that contract.

## Purpose
This contract keeps shadcn as the vendor primitive layer, makes Morphy UX the standalone design-system root, and makes app-ui the semantic composition layer above it.

## Component Layering Contract
| Layer | Location | Ownership | Rules |
|---|---|---|---|
| Stock primitives | `hushh-webapp/components/ui/*` | shadcn registry | Registry-backed only. Treat as vendor code. |
| Morphy UX | `hushh-webapp/lib/morphy-ux/*` and `hushh-webapp/lib/morphy-ux/ui/*` | Hussh | Own reusable design-system primitives, motion, tokens, and surface shells. Must compose stock primitives; do not fork primitive internals. |
| App reusable components | `hushh-webapp/components/app-ui/*` | Hussh | App-specific semantic composition belongs here, never in `components/ui`. |
| Feature composition | `hushh-webapp/components/<feature>/*`, `hushh-webapp/app/**` | Hussh | Compose Morphy and app-ui layers; do not create parallel primitives. |

## Canonical Policies
1. Default to stock shadcn imports for baseline controls.
2. Use Morphy when the change belongs to the reusable design-system layer.
3. Keep `components/ui` overwrite-safe with `npx shadcn@latest add ... --overwrite`.
4. Do not place app-specific components inside `components/ui`.
5. Shared segmented tabs live in `@/lib/morphy-ux/ui/segmented-tabs` and are re-exported through `SettingsSegmentedTabs` for app-level composition.
6. Morphy button, card, and surface primitives must compose stock primitives.
7. The liquid-glass lab is experimental and not part of the Kai production design contract.
8. `AppPageShell` and `FullscreenFlowShell` own the route container contract; feature files must not replace that contract with route-local `max-w-* mx-auto px-*` wrappers.
9. The canonical width model is semantic, not Tailwind-sized:
   - `reading`
   - `standard`
   - `expanded`
10. The canonical header accent model is semantic, not raw color-family naming:
   - `neutral`
   - `kai`
   - `ria`
   - `consent`
   - `marketplace`
   - `developers`
11. Email draft HTML is not route UI. Email Helper drafts must use the shared `agent_kyc.approved_disclosure_formatter.v1` strict-ZK renderer so plaintext and Gmail-safe HTML stay synchronized, responsive, and free of consumer-facing implementation noise. Dense email tables need horizontal scroll wrappers with fixed minimum widths instead of squeezed mobile columns.
12. Agent-aware dialogs, popovers, sheets, menus, and confirmations publish authored
    interaction-layer metadata from app-level composition. Stock primitives remain
    registry-safe and contain no app action ids or voice semantics.

## Morphy Extension Allowlist
1. CTA-level behavior on top of stock button semantics.
2. Shared card and surface treatment on top of stock card structure.
3. Ripple, motion hooks, icon wrappers, and toast helpers.
4. Confirmation and notification composition must stay on stock shadcn primitives: `alert-dialog` for destructive confirmation and `sonner` for transient status.
5. Morphy AX may derive redacted layer posture, action availability, and Agent
   continuity; it never owns visual styling or primitive behavior.

## Import Rules
Use stock shadcn by default for baseline primitives:

```tsx
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
```

Use Morphy for reusable shared UI behavior and app-wide segmented controls:

```tsx
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Card as MorphyCard } from "@/lib/morphy-ux/card";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";
```

Forbidden:
1. Importing moved custom components from `@/components/ui/*` paths that no longer belong to registry ownership.
2. Editing `components/ui/*` for app-specific behavior.
3. Creating primitive forks in Morphy that bypass stock components.
4. Route-local inline banners for transient row actions, saves, deletes, refreshes, or short-lived failures.
5. Global synthetic close actions, DOM-inferred controls, or app-specific voice logic
   inside `components/ui`.

## Interaction-layer stacking and continuity

1. Use shared stacking tokens for route content, scrim, layer content, Agent Bar, and
   security-critical overlays; do not solve individual screens with arbitrary z-index
   escalation.
2. Legal and informational layers may place Agent Bar above the scrim when the layer
   explicitly declares `interactive` continuity and reserves content clearance.
3. Credential, OTP, vault, and destructive layers declare `ambient` or `suppressed`
   continuity. They remain visually and interactively authoritative.
4. Nested confirmation outranks its parent. Closing restores focus and the previous
   interaction inventory before ordinary route controls return.
5. Every dismissible layer supports the appropriate visible, keyboard, outside-click,
   and generated-action paths. Nondismissible layers advertise none.
6. Firebase provider popups remain browser-owned windows. Their lifecycle belongs to
   authentication settlement, not app z-index or dialog composition.

## Charts Contract
1. `hushh-webapp/components/ui/chart.tsx` is the canonical chart primitive layer.
2. Build chart screens with `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, and `ChartLegendContent` from stock chart.
3. Keep feature chart files focused on data mapping and presentation, not primitive duplication.
4. Use semantic chart config keys and CSS chart tokens first; avoid ad-hoc per-chart hardcoded palettes.

## Visual Tokens
1. Keep color, typography, radius, and motion centralized through existing tokens and CSS variables.
2. Avoid legacy references and hardcoded old theme narratives in feature code.
3. Keep backgrounds and surfaces aligned with the current neutral app direction.
4. Shared shell and surface layout tokens live in `hushh-webapp/app/globals.css`.
5. Color identity is the **Foundation** system with ONE switchable accent: the `--app-accent-*` family in `hushh-webapp/app/globals.css` (iOS Blue by default, Molten Gold under `html[data-accent="gold"]`, toggled in Profile → Preferences → Accent and persisted at `hushh.app.accent.v1` via `lib/theme/accent.ts`). Accent is emphasis ONLY; ink (`--primary`) carries primary, gray carries support. Legacy names (`--foundation-gold-*`, `--color-accent-*`, `--brand-*`, `--morphy-primary-*`, `--tone-blue*`) alias the accent family, so consumers written against them follow the preference automatically. Never hardcode an accent hex in component source; `npm run verify:accent-tokens` (part of `verify:design-system`) enforces this. RIA compatibility tokens must resolve through that same family; no persona may retint shared app chrome or bypass the active accent. The full Foundation Color Contract lives in [app-surface-design-system.md](./app-surface-design-system.md#foundation-color-contract).
5a. Promotion path for feature design systems: when a route (e.g. One Location) proves out a surface grammar, promote its tokens to `lib/morphy-ux/tokens/surfaces.ts` and its primitives to `lib/morphy-ux/ui/surface-primitives.tsx`, leave a re-export shim at the feature path, and consume the `--app-accent-*` family for any accent usage so the promoted pieces stay accent-neutral.
5b. Portable PDF artifacts use the Morphy-owned
    `lib/morphy-ux/pdf-document-formatter.mjs`. The Markdown/PDF script is a
    generator only: it reads Foundation tokens from `app/globals.css` and uses
    a named `technical`, `partner`, or `founder` formatter profile. Light and
    dark wordmarks use the same `hu` ink and `ssh` foil tokens as the app;
    Molten Gold is explicit. Protocol code blocks retain the Sublime Monokai
    surface in every profile.
6. Use the container tokens below instead of ad hoc `max-w-*` route wrappers:
   - `--app-shell-reading`
   - `--app-shell-standard`
   - `--app-shell-expanded`
7. Use shared gutter tokens instead of route-local page padding:
   - `--page-inline-gutter-standard`
   - `--page-surface-overscan`
8. **Apple design grammar** (adopted principles; enforced by `verify:accent-tokens`):
   - Radius grammar: shapes carry meaning. `--app-radius-pill` = action signal (CTAs, chips, search, toggles); `--app-radius-lg` (18px) = compact utility cards (the shipped `--app-card-radius-*` 20/22/24 contract remains canonical for app cards); `--app-radius-sm` (8px) = compact utility rects. Do not invent radii between the stops in new components.
   - Press physics: the system-wide active state is the `.press-scale` utility (`--motion-press-scale: 0.95`, transform-only, reduced-motion aware), layered with the md-ripple. Wired into the Morphy Button and all segmented primitives; do not write per-component press styles.
   - Weight ladder: 300 / 400 / 600 / 700. Weight 500 (`font-medium`) is deliberately absent from `lib/morphy-ux`; labels are 400, active/strong emphasis is 600, weight 300 is a rare opt-in "airy" cue (`.type-lead-airy`).
   - Typography rungs: `.type-lead` (28/400), `.type-lead-airy` (24/300), `.type-tagline` (21/600), `.type-dense-link` (17/400/2.41) join the Foundation scale for editorial/marketing surfaces.
   - Elevation doctrine: UI elevation comes from surface change and backdrop blur, not chrome shadows. `--app-shadow-product` is the single photographic drop-shadow, reserved for imagery resting on a surface; `--app-blur-frosted` is the frosted-chrome baseline.
   - Tile system: full-bleed marketing/onboarding tiles alternate light and near-black (`--app-tile-dark-1/2/3`); the color change is the divider (no borders, no rounding, no shadows between tiles). In-copy links on dark tiles use `--app-accent-link-on-dark`.
   - Legal note: SF Pro resolves via the system font stack only (`--font-app-*`); never bundle Apple font files. The measured scales and principles above are facts, not copied assets.

## Guardrails
Use these commands from `hushh-webapp`:

```bash
npm run verify:design-system
npm run verify:cache
npm run verify:docs
```

What they enforce:
1. `components/ui` folder purity and stale-import protection.
2. Strict registry parity for registry-backed UI files.
3. Cache mutation coherence hooks.
4. Documentation/runtime contract parity.

## Regeneration Workflow
When updating registry-backed components:

```bash
npx shadcn@latest add accordion alert-dialog avatar badge breadcrumb button card carousel chart checkbox collapsible combobox command dialog drawer dropdown-menu input input-group kbd label pagination popover progress radio-group scroll-area select separator sheet sidebar skeleton sonner spinner table tabs textarea tooltip --overwrite
```

After regeneration:
1. Re-run all verification commands.
2. Keep Morphy wrappers compositional and API-stable.
3. Update docs only when rules actually change.

## Repo-Owned Skills

Project-local UI skills live in `.codex/skills/`:

1. `frontend`
2. `frontend-design-system`
3. `frontend-architecture`
4. `frontend-surface-placement`
5. `frontend-native-surface-mapper`
6. `morphy-ax`

These skills must stay aligned with this document, `frontend-ui-architecture-map.md`, and the runtime verification commands.

Morphy UX owns reusable visual primitives. The narrower `morphy-ax` spoke owns pure redacted agent-state derivation and compatibility; see [Morphy Agent Experience](./morphy-agent-experience.md).

## Settings Surfaces
The Profile page is the canonical settings implementation for the app.

Reference:

1. `hushh-webapp/components/app-ui/settings-ui.tsx`
2. `hushh-webapp/app/profile/profile-workspace-page.tsx`
3. [Profile Settings Design System](./profile-settings-design-system.md)
4. [App Surface Design System](./app-surface-design-system.md)
5. [App Surface Audit Matrix](./app-surface-audit-matrix.md)

Use that companion doc when building any Apple-like settings surface so spacing, grouping, responsive behavior, and action-row semantics stay consistent.

Body section headings are not page headers. `SectionHeader` and `SettingsGroup` must use compact accessible headings above row text, below page-title scale, and independent from global `h1`/`h2` element rules. `SettingsGroup` must keep eyebrow text inline with the section title and avoid a separate eyebrow/title/description three-line stack inside page content.

## Lean Route Headers And Responsive Lists

Signed-in routes use `AppPageHeaderRegion` with the shared `PageHeader`: a compact title, an optional single-line description, and no route-local hero, logo, or duplicate agent selector. RIA uses the same shell and resolves its accent through the Foundation `--app-accent-*` family.

`SettingsGroup` and `SettingsRow` are the standard responsive list system for Profile, agents, and Connected Systems. Groups use the compact utility radius, inset separators, text truncation, and mobile-stacked trailing controls. Do not make a desktop `DataTable` the only way to operate a narrow route.
