# Hushh Design System — Apple iCloud Model

> This document is the single source of truth for all design decisions.
> Every component, page, and layout MUST follow these rules. No exceptions.

---

## 1. Colors (Apple iCloud)

### Light Mode
| Token | Value | Usage |
|-------|-------|-------|
| `--background` | `#f5f5f7` | Page background |
| `--card` | `#ffffff` | Card/surface background |
| `--foreground` | `#000000` | Primary text |
| `--muted-foreground` | gray | Secondary text |
| `--app-bg-*` | `#f5f5f7` | App background gradient (uniform) |

### Dark Mode
| Token | Value | Usage |
|-------|-------|-------|
| `--background` | `#1d1d1f` | Page background |
| `--card` | `#2c2c2e` | Card/surface background |
| `--foreground` | `#fafafa` | Primary text |
| `--app-bg-*` | `#1d1d1f` | App background gradient (uniform) |

### Rule: Depth comes from CONTRAST between background and card, NOT from heavy shadows or borders.

---

## 2. Shadows (Apple iCloud — Single Box-Shadow)

### Card Shadows
| Mode | Value | Source |
|------|-------|--------|
| Light | `0 11px 34px 0 rgba(120, 120, 128, 0.16)` | Apple `--theme-color-fillSecondary` |
| Dark | `0 11px 34px 0 rgba(0, 0, 0, 0.65)` | Apple `--theme-color-boxShadow` |

### Mobile (<640px)
| Mode | Value |
|------|-------|
| Light | `0 1px 3px 0 rgba(120, 120, 128, 0.1)` |
| Dark | `0 1px 3px 0 rgba(0, 0, 0, 0.35)` |

### Shadow Scale (`--shadow-*`)
```
xs: 0 4px 12px 0 rgba(120, 120, 128, 0.08)
sm: 0 8px 24px 0 rgba(120, 120, 128, 0.12)
md: 0 11px 34px 0 rgba(120, 120, 128, 0.16)  ← default card
lg: 0 11px 34px 0 rgba(120, 120, 128, 0.22)  ← feature card
xl: 0 16px 48px 0 rgba(120, 120, 128, 0.28)
```

---

## 3. Borders: NONE

**Rule:** Zero visible borders on cards, surfaces, navbar, tabs, or chrome.
All `--app-card-border-*` tokens are `transparent`.
Use shadow for depth. Use background color contrast for separation.

---

## 4. Border Radius Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `16px` | Badges, inputs, small elements |
| `--radius-md` | `20px` | Standard cards, rows, tabs |
| `--radius-lg` | `28px` | Hero cards, modals, navbar pill |

---

## 5. Cards (`type="apple"`)

All `SurfaceCard` components use `type="apple"` by default.

**Apple card renders:**
- `bg-card` (solid — `#ffffff` light, `#2c2c2e` dark)
- `shadow-[var(--app-card-shadow-standard)]`
- `border-0` (no border)
- `rounded-[var(--radius-md)]`
- No glass overlay, no backdrop-blur, no gradient

**Never:**
- Card inside card (nested elevation)
- Glass effects on data cards
- Hardcoded rgba backgrounds
- Border with opacity fractions

---

## 6. Headers — PageHeader & SectionHeader

Both use **identical layout**:

```
┌─────────────────────────────────────────┐
│ [ICON]  EYEBROW           [ACTIONS]     │
│         Title                           │
│         Description                     │
│─────────────────────────────────────────│  ← accent divider
└─────────────────────────────────────────┘
```

### Layout Rules:
- **Parent flex:** `items-stretch` — icon stretches to full header height
- **Icon:** `<div>` (NOT `<span>`), no `h-full`, no `self-start`
- **Icon position:** ALWAYS LEFT, first child in flex row
- **Icon sizing:** `w-10 sm:w-12` — stretches vertically via flex
- **Actions:** RIGHT side, vertically centered
- **Accent styles:** Applied via `accent="sky|emerald|violet|amber|rose"` prop

### NEVER:
- Put icon on the right
- Use `self-start` on the icon (breaks stretch)
- Use `<span>` for the icon wrapper (inline elements don't stretch)
- Add `h-full` to the icon (conflicts with flex stretch)

---

## 7. Section Spacing

Between chained sections on content-heavy pages:

```
<div className="space-y-12">  ← 48px between sections
  <section className="space-y-4">  ← 16px internal
    <SectionHeader ... />
    <content />
  </section>
  <section className="space-y-4">
    <SectionHeader ... />
    <content />
  </section>
</div>
```

---

## 8. Bottom Navbar

- `border-0` — no border
- `bg-background/80` — subtle transparency
- `backdrop-blur-[var(--blur-standard)]` — frosted glass
- `shadow-[0_11px_34px_0_var(--theme-color-boxShadow)]` — Apple shadow
- Active indicator: `bg-black/10 dark:bg-white/15` with `backdrop-blur-sm`
- Active text: `text-foreground font-semibold`
- Inactive text: `text-foreground/60`
- Spring animation: `cubic-bezier(0.34, 1.56, 0.64, 1)`

---

## 9. Tabs (SettingsSegmentedTabs)

- Container: `bg-muted/50 dark:bg-white/6`, `rounded-[var(--radius-sm)]`, `border-0`, `p-1.5`
- Active tab: `bg-card`, `font-semibold`, `shadow-[0_2px_8px_rgba(0,0,0,0.08)]`
- Inactive tab: `bg-transparent`, `text-muted-foreground`
- Same component used everywhere: Profile, Connections, Consents, etc.

---

## 10. Top App Bar Icons (Bell/Shield)

```
TOP_SHELL_ICON_BUTTON_CLASSNAME:
  h-10 w-10 rounded-full border-0 bg-card text-foreground
  shadow-[var(--app-card-shadow-standard)]
  hover:scale-105 active:scale-95
```

**All top bar icon buttons MUST use this className.** No per-component overrides.
Inner icons: raw Lucide at `h-5 w-5` (consistent size).

---

## 11. Glass Mask (Top & Bottom Chrome)

Both top and bottom use the SAME color variables:
```
--app-bar-glass-bg-light: rgba(245, 245, 247, 0.72)
--app-bar-glass-bg-dark: rgba(29, 29, 31, 0.72)
--app-bar-mask-overscan: 14px
```

Gradient overlay colors match the background:
- Light `::after`: `rgba(245, 245, 247, opacity)`
- Dark `::after`: `rgba(29, 29, 31, opacity)`

---

## 12. Accent Colors

| Accent | Light Icon BG | Dark Icon BG | Usage |
|--------|--------------|-------------|-------|
| sky | `bg-sky-500/10` | `dark:bg-sky-400/10` | Connections, marketplace |
| emerald | `bg-emerald-500/10` | `dark:bg-emerald-400/10` | Portfolio, active states |
| violet | `bg-violet-500/10` | `dark:bg-violet-400/10` | Analysis, signals |
| amber | `bg-amber-500/10` | `dark:bg-amber-400/10` | Warnings, pending |
| rose | `bg-rose-500/10` | `dark:bg-rose-400/10` | Market, spotlight |

---

## 13. Profile Header

Profile page uses a CUSTOM centered layout (not PageHeader):
```
<header className="flex flex-col items-center gap-3 text-center">
  <Avatar />
  <h1>Name</h1>
  <p>Email</p>
</header>
```

---

## 14. Responsive Rules

- Icon in headers: stretches on ALL viewports (no `self-start` mobile override)
- Actions in headers: visible on all viewports (no `sm:hidden`)
- Badge/status in titles: use `inline-flex flex-wrap` to wrap gracefully
- Refresh buttons: `size="icon"` (circle) to stay compact
- Card shadows: reduced on mobile via `@media (max-width: 639px)` override

---

## 15. Motion & Animation

| Token | Value | Usage |
|-------|-------|-------|
| Standard ease | `cubic-bezier(0.2, 0, 0, 1)` | Material 3 standard |
| Emphasized ease | `cubic-bezier(0.2, 0, 0, 1)` | Page enters, primary |
| Spring ease | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Navbar indicator, tabs |
| Duration xs | 120ms | Micro-interactions |
| Duration md | 240ms | Standard transitions |
| Duration xl | 450ms | Page enter, reveals |

GSAP used for: page enter animations, feature rail trails, carousel deck focus.
CSS used for: tab indicators, button hover/active, navbar scroll-hide.
