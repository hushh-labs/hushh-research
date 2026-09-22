# Component Development Guidelines

## Quick Rules
1. `components/ui/*` is registry-owned stock shadcn only.
2. Put app-specific reusable components in `components/app-ui/*` or feature folders.
3. Use stock primitives by default.
4. Morphy UX is the standalone design-system root for reusable surfaces, motion, ripple, and tokens.
5. Keep chart primitives stock via `components/ui/chart.tsx`.
6. Never add custom files to `components/ui`.
7. Frame pacing is a contract, not an audit. A new surface animates only
   `transform` and `opacity`; never writes a custom property on `<html>` per
   frame (write on the element that consumes it); never registers a
   non-passive touch listener on `window`; never watches `document.body` with
   a subtree observer; never sets `will-change` outside the gesture that needs
   it; never drives a React state update from an audio, scroll or streaming
   frame; passes `CHART_ANIMATION_ACTIVE` to every chart series and
   `CHART_TOOLTIP_TRIGGER` to every chart tooltip; takes any
   z-index from the `--z-*` ladder; never puts `backdrop-blur` on a list
   row that moves under a flick (the `backdrop-filter-on-list-row` rule;
   blur stays on fixed chrome); and passes
   `debounce={CHART_RESIZE_DEBOUNCE_MS}` to every raw `ResponsiveContainer`.
   `npm run verify:render-performance` fails
   a violation, and the allowlist beside it only shrinks. The reasoning and the
   measuring tools are in `docs/reference/mobile/render-performance-charter.md`;
   a change to the shell scroll engines, sheets, streaming or the chrome masks
   ships with before/after probe numbers (`?perf=1`).

## Form geometry

Core direct-entry controls use the shared `--app-input-radius` capsule token.
`Input`, `InputGroup`, `Textarea`, `SelectTrigger`, `CommandInput`, and
combobox field shells must use that token; compound controls keep inner
controls square. Use the shared `--app-form-field-gap`, `--app-form-related-gap`, and
`--app-form-section-gap` tokens for label, related-action, and section rhythm.
Credential escape actions keep Recovery key beside Sign out in one quiet group
when the hard gate exposes both, while preserving 44px hit targets.

## Folder Ownership
| Folder | Purpose |
|---|---|
| `components/ui/*` | Stock shadcn primitives; overwrite-safe vendor layer |
| `lib/morphy-ux/*` | Morphy design-system primitives, tokens, motion, and reusable surface shells |
| `components/app-ui/*` | Reusable semantic app-specific components composed from Morphy + stock primitives |
| `components/<feature>/*` | Feature-level composition |

## Data Access Rule
Components do not call backend APIs directly.

Do:
1. Route network work through service modules in `lib/services/*`.
2. Keep platform differences in the service layer.

Do not:
1. Use raw `fetch()` in feature components for app API contracts.

## Component Selection
Use stock by default:

```tsx
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
```

Use Morphy extension when required:

```tsx
import { Button } from "@/lib/morphy-ux/button";
import { Card } from "@/lib/morphy-ux/card";
```

Use moved app components from `components/app-ui`:

```tsx
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { TopAppBar } from "@/components/app-ui/top-app-bar";
```

## Verification Commands
Run from `hushh-webapp`:

```bash
npm run verify:design-system
npm run verify:render-performance
npm run verify:service-boundary
npm run verify:cache
npm run verify:docs
npm run typecheck
npm run lint
```

## References
1. `docs/reference/quality/design-system.md`
2. `docs/reference/quality/frontend-ui-architecture-map.md`
3. `docs/reference/quality/frontend-pattern-catalog.md`
4. `docs/reference/architecture/cache-coherence.md`
5. `docs/reference/mobile/render-performance-charter.md`
