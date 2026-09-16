# Component Development Guidelines

## Quick Rules
1. `components/ui/*` is registry-owned stock shadcn only.
2. Put app-specific reusable components in `components/app-ui/*` or feature folders.
3. Use stock primitives by default.
4. Morphy UX is the standalone design-system root for reusable surfaces, motion, ripple, and tokens.
5. Keep chart primitives stock via `components/ui/chart.tsx`.
6. Never add custom files to `components/ui`.

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
