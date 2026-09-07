# One UX and AX Design Contract

Status: current execution contract.

## Visual Map

```mermaid
flowchart TB
  foundation["Foundation tokens\ncolor, type, radius, safe areas"]
  ux["Morphy UX\nsurfaces, material physics, controls"]
  shell["One app shell\ntop workspace tabs + fixed utilities"]
  ax["Morphy AX\nredacted state + presentation posture"]
  routes["Route composition\nheaders, lists, content"]

  foundation --> ux --> shell --> routes
  foundation --> ax
  ax --> shell
```

This is the concise design authority for One. It is informed by the checked
Apple interaction reference: quiet system typography, a restrained single
accent, legible hierarchy, and chrome that recedes behind the work. It does
not copy Apple branding or substitute a separate palette for Hussh.

## Ownership

| Layer | Owns | Does not own |
| --- | --- | --- |
| Foundation | semantic color, typography, radius, safe-area, and motion tokens | route-specific visual exceptions |
| Morphy UX | reusable surfaces, controls, ripples, glass, and motion | agent decisions or protected information |
| app-ui | the shared One shell, headers, lists, and route composition | vendor primitive forks |
| Morphy AX | redacted interaction state and lifecycle presentation posture | visual primitives, routing, or action authority |
| feature routes | content and domain-specific tabs using the shared shell | custom fixed chrome or token overrides |

Use `components/ui` for stock shadcn primitives, `lib/morphy-ux` for reusable
visual behavior, and `components/app-ui` for One-specific composition. A route
must not recreate shell chrome, safe-area math, an icon well, or a list row.

## Visual Language

1. **Restraint is the first law (the Restraint Charter).** One is quiet, direct,
   and information-first; clutter is a defect, not a matter of taste. Five rules,
   in precedence order, apply to every screen:
   1. **One title per screen.** The page header owns the heading. A single card
      below it must not restate the screen's title or description; a card title
      exists only to disambiguate *several* cards on one screen.
   2. **One primary action.** Exactly one control reads as primary; every other
      action is visibly demoted (secondary, ghost, or a quiet text link). Never
      two primary buttons, and never the same action rendered as two buttons.
   3. **Earn every element.** The default is removal. A heading, badge, paragraph,
      or control that does not change the decision the person is about to make is
      deleted.
   4. **Progressive disclosure.** Show only what the next decision needs; defer
      the rare or advanced path (create-it-yourself commands, delegated grants,
      advanced options) behind a quiet toggle or a detail surface.
   5. **No decorative badges.** A badge or pill must encode actionable,
      decision-relevant state. A badge that restates a button's enabled state or
      fills quiet space is deleted.
2. The Foundation `--app-accent-*` family is the only accent authority. Blue is
   the default; Molten Gold is the user-selected variant. Dark surfaces derive
   from `--background` with `color-mix`, never a hard-coded near-black.
3. White space is structural: page gutters, safe areas, and shared shell
   clearance are intentional. Do not add empty hero space, decorative cards,
   duplicate headers, badge farms, or skeleton-screen chrome.
4. Cards communicate grouping, not decoration. Use flat inset lists for browse
   flows; reserve cards for a real summary, image, chart, or distinct task.
5. Copy uses plain language. One is the private agent; Kai is the finance
   specialist; Nav is the privacy and consent guardian; KYC is the identity
   workflow specialist.

## Unified Mobile Header Guidelines

To maintain absolute uniformity across mobile screens, all top-level workspace pages must adhere to the high-end centered layout of the Profile tab:

1. **No Mixed/Stacked Headers:** Double headers, stacked titles, and triple-line headers are strictly prohibited. The page title must never be repeated below the top app bar breadcrumbs.
2. **Clean Centered Typography:** The main screen title and its single-sentence supporting description must be perfectly centered on candidate screens, using Apple-clean typography and a maximum description layout width of `480px` for optimal legibility.
3. **Specialist Squircle Wells:** Workspace icons must be displayed inside glowing frosted squircles (`rounded-[18px]` to `rounded-[22px]`) with a color-matched blurred glow backdrop. Full `rounded-full` circle backgrounds on iconwells are prohibited.
4. **Standalone Left Back Button:** On sub-pages, the back button must sit on its own dedicated body row immediately preceding the main centered header layout (using a clean circular button with a discrete left margin), keeping the typography area immaculate and un-overloaded.

## Material 3 Expressive Physics & Transforms

The Morphy design language relies on physics-based responsive motion, transitioning away from rigid, linear CSS timelines toward fluid underdamped spring interactions.

### 1. Unified Spring Physics
Transforms and popovers model a spring-mass-damper system. Underdamped transitions ($\zeta < 1$) establish smooth, natural bounce profiles. The physical displacement is governed by:

$$m \frac{d^2x}{dt^2} + c \frac{dx}{dt} + kx = 0$$

Where:
- $m$ is the mass (standard = `1.1`), creating a tactile weight feeling.
- $k$ is the spring stiffness (high = `180`, compact = `260`).
- $c$ is the damping coefficient (underdamped $\zeta = c / (2\sqrt{km}) \approx 0.76$).

In CSS, these map to custom bezier ease curves that recreate this momentum:
- **Expressive Expand / Swell:** `cubic-bezier(0.34, 1.56, 0.64, 1)` — creates a subtle, tactile target overshoot during scale transforms.
- **Emphasized Standard Ease:** `cubic-bezier(0.2, 0.8, 0.2, 1)` — provides a premium decelerating entrance.

### 2. Physical Scale Swells & Inertial Deceleration
- **Scale Swell Transitions:** Active dialogue boxes and command search sheets zoom-in from `scale(0.95)` to `scale(1.0)` with a concurrent `blur(8.0px)` backdrop opacity fade, dampening visual pop.
- **Flick Momentum:** List elements and carousels use smooth decay deceleration rates ($v(t) = v_0 \cdot e^{-t / \tau}$ where $\tau \approx 0.2$ represents resistive canvas decay), matching natural touch drags on WebKit and native viewports.

## Shape and Icon Rules

The radius token does not mean every square is a circle.

| Surface | Geometry | Allowed radius |
| --- | --- | --- |
| app icon / launcher artwork | square | 18px card, 20px launcher, 10px menu/top-bar |
| settings and list icon well | square | 10px at 32px, 12px at 40px |
| grouped inset list | compact card | `--app-card-radius-compact` |
| cards and media | semantic card token | `--app-card-radius-*` only |
| standalone chrome control | circular or pill only when it is a control | `--app-radius-pill` |
| avatar, presence dot, toggle thumb | circular | `--app-radius-pill` |

Never use `rounded-full` for a settings, launcher, or app-icon well. Reuse
`AgentSectionIcon` for agent artwork and `SettingsRow` for settings icon wells.
Do not use the small generic control radius as the outer radius of a list group
or card.

## Signed-in Shell Contract

One fixed shell applies to every signed-in standard route. Onboarding, login,
and other explicitly hidden/flow layouts remain exempt through the route layout
contract.

```text
safe area
┌ One / current workspace     workspace tabs                  alerts + Profile ┐
│ Finance                     Market · Portfolio · Analysis                    │
└──────────────────────────────────────────────────────────────────────────────┘
                                     route content
                              Agent Bar (6px visual join)
                              One · Connect · Search
safe area
```

1. The centered primary bottom navigation is fixed and constant: **One**,
   **Connect**, and **Search**. Search is a segment in that shared control and
   opens the global command surface. Profile remains a top-bar control.
2. Search opens the existing global command/search surface. It is not agent
   chat and has no route-local replacement.
3. The Agent Bar and bottom utility bar are one bottom-chrome stack. Their
   resting visual separation is 6px; their transforms, safe-area clearance,
   and fade are measured by the shared shell. Neither route nor component may
   add another gap.
4. Finance and RIA workspace tabs render only in the unified top shell. Their
   labels, destinations, active query state, and visibility come from the
   central route registry; route bodies and bottom navigation do not duplicate
   them.
5. The rightmost signed-in top-bar control is Profile. It uses the signed-in
   person's image when available and the same generic/initial fallback as the
   Profile route. Connect remains a route but is not shell chrome.
6. Tabs are horizontally scrollable when needed, retain clear selected state,
   and do not push or overlap the top-bar actions on a small viewport.
7. The bottom utility frame uses the exact Agent Bar width constraint. Its
   three segments are equal-width and centered at every breakpoint; it never
   aligns to the wider page shell or viewport edge.
8. Finance is one `/one/kai?tab=` workspace. Market, Portfolio, and Analysis
   use the Profile reading measure and shared outer gutter; their content may
   vary, but they must not introduce a wider dashboard canvas, a second fixed
   header, or a route-local tab bar.

## List and Header Rules

1. Every standard signed-in route uses the lean shared header; no route-local
   logo, hero, or duplicate title bar.
2. Profile is the geometry reference for a primary workspace header: one
   `AppPageShell` at the reading measure, one `AppPageHeaderRegion`, and one
   primary `PageHeader` or profile identity header. Finance tab content may
   render supporting section headings, but it must not create a competing
   primary header above or beside the shared workspace header.
3. `SettingsGroup` and `SettingsRow` own responsive inset lists: icon well,
   separator, truncation, 44px+ tap target, trailing alignment, and mobile
   stacking. Connected Systems, Profile, and agent lists use the same model.
4. Section starts align on a stable grid. Do not distribute a short row of
   icons across a wide surface.
5. A list row has one primary action. Nested controls must be explicit and
   cannot create a competing full-row click target.
6. First-time source selection (such as portfolio import) uses one lean shared
   header and one compact inset list. Keep the initial decision state within a
   phone viewport: no decorative cards, status badges, drag zones, repeated
   primary buttons, or terminal setup action before the user has chosen a
   source. Progress and completion controls appear only after that choice.

## AX Boundary

Morphy AX may choose presentation posture from redacted signed-in, vault,
route, interaction-layer, and active-agent state. It may not read protected
information, alter navigation, add a visual primitive, infer controls from the
DOM, or create an action. UX is the visual grammar; AX is the bounded,
privacy-safe presentation input.

## Verification

For shared shell changes, prove:

1. route-contract, bottom-navigation, and top-tab unit contracts;
2. phone and desktop browser geometry for top tabs, bottom utilities, Agent
   Bar, safe areas, and keyboard behavior;
3. typecheck, design-system, route, AX, and docs verification;
4. no duplicate chrome, circular app wells, hard-coded theme colors, or
   unmeasured bottom-stack spacing.

Companion references:

- [Design System](./design-system.md)
- [App Surface Design System](./app-surface-design-system.md)
- [Morphy Agent Experience](./morphy-agent-experience.md)
- [Frontend UI Architecture Map](./frontend-ui-architecture-map.md)
