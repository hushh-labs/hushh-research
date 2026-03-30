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

## Pattern: Morphy Surface Extension
Use when a screen needs a premium interactive surface.

```tsx
import { Card, CardContent } from "@/lib/morphy-ux/card";

<Card variant="none" effect="glass" showRipple={false}>
  <CardContent className="p-4">...</CardContent>
</Card>
```

## Pattern: Tabs Base + Optional Morphy Wrapper
Use stock tabs for default behavior. Use Morphy tabs only when ripple/state-layer upgrades are intentional.

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
```

```tsx
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/lib/morphy-ux/ui/tabs";
```

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
