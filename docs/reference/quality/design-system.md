# Hushh Frontend Design System


## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose
This contract makes shadcn primitives the canonical base and keeps Morphy as a compositional extension layer.

## Component Layering Contract
| Layer | Location | Ownership | Rules |
|---|---|---|---|
| Stock primitives | `hushh-webapp/components/ui/*` | shadcn registry | Registry-backed only. Treat as vendor code. |
| Morphy extensions | `hushh-webapp/lib/morphy-ux/*` and `hushh-webapp/lib/morphy-ux/ui/*` | Hushh | Must compose stock primitives; do not fork primitive internals. |
| App reusable components | `hushh-webapp/components/app-ui/*` and feature folders | Hushh | App-specific behavior belongs here, never in `components/ui`. |

## Canonical Policies
1. Default to stock shadcn imports for baseline controls.
2. Use Morphy extensions only when explicit upgrade value exists.
3. Keep `components/ui` overwrite-safe with `npx shadcn@latest add ... --overwrite`.
4. Do not place app-specific components inside `components/ui`.
5. Keep tabs stock-first: `@/components/ui/tabs` is the canonical primitive base.
6. Morphy tabs, button, and card must compose stock primitives.

## Morphy Extension Allowlist
1. CTA-level behavior on top of stock button semantics.
2. Premium surface treatment on top of stock card structure.
3. Tabs interaction upgrades as a wrapper over stock tabs.
4. Ripple, motion hooks, icon wrappers, and toast helpers.

## Import Rules
Use stock shadcn by default:

```tsx
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
```

Use Morphy only for explicit extension cases:

```tsx
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Card as MorphyCard } from "@/lib/morphy-ux/card";
import { Tabs as MorphyTabs } from "@/lib/morphy-ux/ui/tabs";
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

## Settings Surfaces
The Profile page is the canonical settings implementation for the app.

Reference:

1. `hushh-webapp/components/profile/settings-ui.tsx`
2. `hushh-webapp/app/profile/page.tsx`
3. [Profile Settings Design System](./profile-settings-design-system.md)
4. [App Surface Design System](./app-surface-design-system.md)
5. [App Surface Audit Matrix](./app-surface-audit-matrix.md)

Use that companion doc when building any Apple-like settings surface so spacing, grouping, responsive behavior, and action-row semantics stay consistent.
