---
name: hushh-icon-theme
description: Authoring, styling, and integrating official Phosphor base SVG icons for Hushh capabilities and navigation. Use when designing, creating, or configuring agent capability icons with pure, flat Phosphor duotone vector geometry, signature capability color tones, zero 3D artifacts, zero viewBox clipping, transparent backgrounds, deep obsidian dark mode contrast, crisp light mode surfaces, and edge-to-edge agent chat layout.
---

# Hushh Icon Theme & Surface Contrast Skill: Pure Flat Phosphor & Obsidian Standards

> Authoritative standard for capability icons, navigation icons, dark/light chrome contrast, and edge-to-edge layout across the Hushh / One platform.

---

## 1. Iconography Philosophy & Standard

Hushh interfaces demand an aesthetic of **quiet luxury, high-contrast clarity, and modern technical craft**.

1. **Official Phosphor Geometry Base**: Every capability and navigation icon is an authentic Phosphor icon (`Bank`, `Wallet`, `MapPin`, `UsersThree`, `EnvelopeSimple`, `CalendarBlank`, `IdentificationCard`, `Graph`, `LockKey`, `Storefront`, `PlugsConnected`, `SquaresFour`, `ChatCircle`, `Compass`). No cartoonish doodles, no fake 3D shadows, no clip-art.
2. **Pure Flat Vector Aesthetic**: Flat 2D vector geometry with Phosphor's duotone weight (primary silhouette at 100% opacity, secondary contour at 20% opacity).
3. **Focused Signature Palette**: Each icon has a single signature capability hue (not multi-color or rainbow):
   - **Finance**: Emerald (`#10B981`)
   - **Wallet**: Amber (`#F59E0B`)
   - **Location**: Crimson (`#EF4444`)
   - **RIA**: Royal Purple (`#8B5CF6`)
   - **Email** (Gmail): Rose / Scarlet (`#E11D48`)
   - **Calendar**: Sky / Ocean Blue (`#0284C7`)
   - **KYC**: Cobalt Blue (`#2563EB`)
   - **Memory**: Indigo (`#6366F1`)
   - **Consent**: Safety Orange (`#F97316`)
   - **Marketplace**: Forest Emerald (`#059669`)
   - **Connected Systems**: Electric Cyan (`#00E5FF`)
4. **Zero ViewBox Clipping**: Always preserve Phosphor's native `viewBox="0 0 256 256"`. Never crop the viewBox. Scale cleanly via container CSS dimensions (`classes.lucide`).
5. **Clean Transparent Canvas**: Custom capability icons sit on transparent backdrops without artificial colored squircle box backgrounds (`!bg-transparent !shadow-none !ring-0`).
6. **Muted & Loading States**: Muted states preserve the exact same flat duotone geometry with `currentColor` / muted opacity without falling back to solid gray boxes or inconsistent geometry.

---

## 2. Mathematical Geometry Baseline

- **Coordinate Canvas**: Uniform native `viewBox="0 0 256 256"`.
- **Weight**: Phosphor `weight="duotone"` (or `weight="fill"`).
- **Styling**: `color` prop sets the primary hue; secondary path renders at `opacity="0.2"`.
- **Container Sizing**: `classes.lucide` controls physical display dimensions with balanced padding inside the tile.

---

## 3. Capability Icon Map

| Capability ID | Display Title | Phosphor Component | Weight | Default Color |
|---|---|---|---|---|
| `finance` | **Finance** | `Bank` | `duotone` | `#10B981` |
| `wallet` | **Wallet** | `Wallet` | `duotone` | `#F59E0B` |
| `location` | **Location** | `MapPin` | `duotone` | `#EF4444` |
| `ria` | **RIA** | `UsersThree` | `duotone` | `#8B5CF6` |
| `gmail` | **Email** | `EnvelopeSimple` | `duotone` | `#E11D48` |
| `calendar` | **Calendar** | `CalendarBlank` | `duotone` | `#0284C7` |
| `email` | **KYC** | `IdentificationCard` | `duotone` | `#2563EB` |
| `pkm` | **Memory** | `Graph` | `duotone` | `#6366F1` |
| `consent` | **Consent** | `LockKey` | `duotone` | `#F97316` |
| `marketplace` | **Marketplace** | `Storefront` | `duotone` | `#059669` |
| `connected-systems` | **Connected Systems** | `PlugsConnected` | `duotone` | `#00E5FF` |

---

## 4. Obsidian Dark Punch & Crisp Light Contrast Standard

To avoid washed-out milky gray tones (`#1c1c1e` / `rgb(28, 28, 30)`), dark mode surfaces must have deep obsidian punch while subtly differentiating from root `#000000`:

1. **Dark Mode Surfaces**:
   - **Root Canvas**: `#000000`
   - **Elevated / Card Surfaces**: Deep obsidian `#0A0A0C` (cards, rosters, search fields) and `#070709` (sidebars).
   - **Floating Chrome (Bottom Bar & Agent Bar)**: `rgba(10, 10, 13, 0.94)` with `border: 0.5px solid rgba(255, 255, 255, 0.12)` and high-depth elevation `0 12px 36px -4px rgba(0, 0, 0, 0.85)`.
   - **Never use milky gray**: Disallow `#1c1c1e` / `#2c2c2e` as card or bar backgrounds.
2. **Light Mode Surfaces**:
   - **Card & Bar Surfaces**: `rgba(255, 255, 255, 0.96)` with crisp hairline border `0.5px solid rgba(0, 0, 0, 0.08)` and subtle shadow `0 10px 30px -8px rgba(0, 0, 0, 0.08)`.

---

## 5. Responsive Edge-to-Edge Chat Layout Standard

1. **Full-Height Sidebar**: Desktop history sidebar takes 100% viewport height (`h-dvh` / `h-full`) from top to bottom edge without arbitrary padding breaks.
2. **Symmetric Unified Top Bar**: Exactly one top bar on canonical `/` route:
   - Left: Active Agent title & status
   - Center: Agent / Puppy mode switcher
   - Right: Model selector, status indicator, and Profile avatar button (`profile-open-button`)
3. **Always-Visible Composer**: The chat text input bar never translates offscreen on scroll (`transform: none`, permanently visible and accessible).
