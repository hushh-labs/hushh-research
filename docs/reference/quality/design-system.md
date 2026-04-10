# Hushh Frontend Design System


## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose
This contract keeps shadcn as the vendor primitive layer, makes Morphy UX the standalone design-system root, and makes app-ui the semantic composition layer above it.

## Component Layering Contract
| Layer | Location | Ownership | Rules |
|---|---|---|---|
| Stock primitives | `hushh-webapp/components/ui/*` | shadcn registry | Registry-backed only. Treat as vendor code. |
| Morphy UX | `hushh-webapp/lib/morphy-ux/*` and `hushh-webapp/lib/morphy-ux/ui/*` | Hushh | Own reusable design-system primitives, motion, tokens, and surface shells. Must compose stock primitives; do not fork primitive internals. |
| App reusable components | `hushh-webapp/components/app-ui/*` | Hushh | App-specific semantic composition belongs here, never in `components/ui`. |
| Feature composition | `hushh-webapp/components/<feature>/*`, `hushh-webapp/app/**` | Hushh | Compose Morphy and app-ui layers; do not create parallel primitives. |

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

## Morphy Extension Allowlist
1. CTA-level behavior on top of stock button semantics.
2. Shared card and surface treatment on top of stock card structure.
3. Ripple, motion hooks, icon wrappers, and toast helpers.

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
5. Use the container tokens below instead of ad hoc `max-w-*` route wrappers:
   - `--app-shell-reading`
   - `--app-shell-standard`
   - `--app-shell-expanded`
6. Use shared gutter tokens instead of route-local page padding:
   - `--page-inline-gutter-standard`
   - `--page-surface-overscan`

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

These skills must stay aligned with this document, `frontend-ui-architecture-map.md`, and the runtime verification commands.

## Settings Surfaces
The Profile page is the canonical settings implementation for the app.

Reference:

1. `hushh-webapp/components/profile/settings-ui.tsx`
2. `hushh-webapp/app/profile/page.tsx`
3. [Profile Settings Design System](./profile-settings-design-system.md)
4. [App Surface Design System](./app-surface-design-system.md)
5. [App Surface Audit Matrix](./app-surface-audit-matrix.md)

Use that companion doc when building any Apple-like settings surface so spacing, grouping, responsive behavior, and action-row semantics stay consistent.
