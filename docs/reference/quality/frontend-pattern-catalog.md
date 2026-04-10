# Frontend Pattern Catalog


## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Pattern: Stock Primitive First
Use when you need baseline UI controls.

```tsx
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Dialog, DialogContent } from "@/components/ui/dialog";
```

## Pattern: Morphy CTA Extension
Use when an action needs upgraded CTA behavior (ripple, premium treatment).

```tsx
import { Button } from "@/lib/morphy-ux/button";

<Button variant="blue-gradient" effect="fill" showRipple>
  Continue
</Button>
```

## Pattern: Morphy Surface Primitive
Use when defining or extending the shared card system itself.

```tsx
import { SurfaceCard, SurfaceInset } from "@/lib/morphy-ux/surfaces";

<SurfaceCard>
  ...
</SurfaceCard>
```

Rules:
1. Primitive surface tokens and shell classes live in `lib/morphy-ux/*`.
2. The analysis-datatable surface treatment is the baseline for shared card chrome.
3. Do not recreate a parallel shared card primitive in `components/app-ui/*` or feature folders.

## Pattern: App Semantic Surface
Use when a route needs a shared semantic wrapper built on Morphy primitives.

```tsx
import { SurfaceCard, SurfaceInset } from "@/components/app-ui/surfaces";
```

Rules:
1. `components/app-ui/surfaces.tsx` is the semantic bridge, not a second primitive system.
2. Feature folders consume these surfaces; they do not fork them.

## Pattern: Shared Segmented Tabs
Use the shared segmented control for app-facing rounded tab groups.

```tsx
import { SegmentedTabs } from "@/lib/morphy-ux/ui";
```

Rules:
1. `@/components/ui/tabs` remains the low-level Radix/shadcn semantic primitive.
2. `@/lib/morphy-ux/ui/segmented-tabs` is the canonical app-facing segmented visual system.
3. Route files should not fork their own segmented shell styling.

## Pattern: App Shell Action Surface
Use the shared shell surface for top-bar actions so ripple, contrast, badges, and focus treatment stay consistent.

```tsx
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
```

Rules:
1. Back, bell, shield, and persona pill interactions all use the same shell surface contract.
2. Dropdown triggers should accept a wrapper or render-trigger path, not just a class string, when ripple ownership is required.

## Pattern: Nested Route Back Navigation
Use the shared top-bar back affordance for signed-in subroutes that drill below a parent workspace.

Rules:
1. Nested routes should navigate back through the top shell, not through feature-local inline buttons.
2. Preserve the parent workspace context in the back target, including route params or query state when that context is part of the flow.
3. Only use inline back controls when the surface is outside the normal shell, such as a modal, sheet, or fullscreen flow.

## Pattern: Signed-In Route Dogfooding
Use the route-contract Playwright sweep for signed-in route families.

```bash
cd hushh-webapp
npm run verify:routes
```

Rules:
1. The route contract in `lib/navigation/app-route-layout.contract.json` is the browser coverage source of truth.
2. The sweep must use the real reviewer login and vault unlock path when the route family is signed-in.
3. Route-specific one-off scripts are for debugging; they do not replace the contract-driven sweep.

## Pattern: Stock Chart Primitives
Use stock chart infrastructure for all chart surfaces.

```tsx
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
```

Rules:
1. Keep tooltip formatting inside `ChartTooltipContent` formatter/labelFormatter.
2. Keep chart files focused on data mapping and composition.
3. Avoid chart primitive forks outside `components/ui/chart.tsx`.

## Pattern: Moved App UI Components
Custom app components now live in `components/app-ui/*`.

```tsx
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { TopAppBar } from "@/components/app-ui/top-app-bar";
```

Do not use:
1. `@/components/ui/hushh-loader`
2. `@/components/ui/top-app-bar`
3. `@/components/ui/data-table`

## Pattern: Toast Usage
Use Morphy toast helper for app notifications.

```tsx
import { morphyToast } from "@/lib/morphy-ux/morphy";

morphyToast.success("Saved");
```

## Pattern: Icon Usage
Use Lucide through the icon wrapper for consistent sizing behavior.

```tsx
import { Shield } from "lucide-react";
import { Icon } from "@/lib/morphy-ux/ui";

<Icon icon={Shield} size="sm" className="text-primary" />;
```

## Pattern: Actionable Surface Rows
Use `SettingsRow` for clickable list rows across the app, not only on Profile.

```tsx
import { SettingsRow } from "@/components/profile/settings-ui";

<SettingsRow
  leading={<span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl">AAPL</span>}
  title="Apple"
  description="AAPL • Technology • BUY"
  trailing="$214.75"
  chevron
  onClick={() => openDetail()}
/>;
```

Rules:
1. The whole row owns hover, press, and ripple.
2. Inner text blocks must not create a second hover state.
3. Use `asChild` for link rows so anchors inherit the same interaction contract.
