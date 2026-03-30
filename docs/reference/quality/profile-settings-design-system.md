# Profile Settings Design System


## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document is the canonical contract for Apple-like settings surfaces in Hushh. The current reference implementation is the Profile page and its shared primitives in `hushh-webapp/components/profile/settings-ui.tsx`.

For broader page-shell, header, and content-surface rules beyond settings, use [App Surface Design System](./app-surface-design-system.md).

## Design Intent

The settings experience should feel:

1. Flat, not dashboard-like.
2. Calm and readable on mobile first.
3. Clean enough that every row looks like part of one system.
4. Specific enough that future settings pages do not drift into ad-hoc cards, noisy surfaces, or mixed interaction patterns.

## Canonical Primitives

### `SettingsSegmentedTabs`

Use for top-level mode switching inside a settings surface.

Rules:

1. Equal-width segments.
2. Active state uses one clear selected surface.
3. Labels stay short.
4. Ripple only on the actionable segment itself.
5. Use this for settings tabs, not for global persona switching.

### `SettingsGroup`

Use as the default container for grouped settings rows.

Rules:

1. Flat grouped surface, never cards-inside-cards.
2. Strong 1px divider treatment.
3. Rounded outer shell with subtle background and blur only at the group level.
4. Optional eyebrow, title, and short supporting description above the group.
5. Description must stay compact; do not write paragraph-length helper text.

### `SettingsRow`

Use as the default interactive row pattern.

Rules:

1. Left side: icon, title, short subtext.
2. Right side: one of chevron, status, toggle, badge, or single compact action.
3. Trailing control stays pinned right on mobile and desktop unless intentionally stacked.
4. The whole row owns hover, press, and ripple behavior.
5. Ripple appears only when the row is actionable.
6. Do not nest buttons inside the text column.
7. If trailing content is interactive, split the row into:
   - primary action zone for navigation/open-detail
   - trailing controls zone for switches/buttons
8. A clickable settings row must never render nested interactive DOM.
9. Avoid long text in trailing slots.

### `SettingsDetailPanel`

Use for dense secondary content.

Rules:

1. Mobile: full-height drawer.
2. Desktop/tablet: right-side sheet.
3. Sticky header with title and optional short description.
4. Dense flows belong here instead of the root settings page.
5. Use for security, consent details, support forms, and similar drill-ins.

## Visual Rules

### Layout

1. One readable column.
2. Do not turn settings pages into dashboard grids.
3. Avoid cards nested inside settings groups.
4. Keep vertical rhythm consistent across sections.

### Divider and surface treatment

1. Prefer strong separators over decorative underlines.
2. Group shells may have subtle blur and shadow.
3. Rows should feel like one contiguous list.
4. Avoid isolated mini-panels inside a group unless the content is destructive or security-critical.

### Typography

1. Titles are compact and medium weight.
2. Supporting text is smaller and tighter than titles.
3. Avoid oversized subtitles.
4. Supporting text should explain action or state in one short sentence.

### Interaction

1. Hover and press behavior must belong to the whole row, not just the text.
2. Ripple is allowed only on actionable controls and rows.
3. Icons should inherit the same emphasis as text in active or highlighted states.
4. Chevrons remain right-aligned and vertically centered.
5. Actionable cards are treated the same way as actionable rows: if a card is clickable, the whole card owns one ripple surface.
6. Decorative icon choices must be semantically grounded. Do not default to generic `Sparkles` for onboarding, optimization, AI, or premium states unless the feature meaning is explicitly “sparkle” or celebratory.

## Responsive Rules

1. Mobile is the primary layout target.
2. Long emails, titles, and descriptions must wrap normally, never letter-stack vertically.
3. Trailing chevrons and toggles stay aligned right.
4. Dense content opens in `SettingsDetailPanel`, not inline expansions that stretch the root page.
5. Safe-area spacing must be respected at the bottom of mobile drawers.

## Vault Access Rules

1. Basic profile functionality must remain usable without unlocking the vault:
   - account/session actions
   - support flows
   - consent manager entry
   - marketplace visibility
   - navigation into the broader Kai or RIA workspace
2. Only rows that read or mutate encrypted vault-backed state should prompt unlock on demand.
3. If a vault does not exist yet, route the user to the creation/import flow instead of showing an unlock prompt.
4. Locked vault state should change row copy and badges, not make the whole profile surface unavailable.

## Approved shadcn primitives for settings surfaces

These are already used on the Profile page and are the approved baseline:

1. `Sheet`
2. `Drawer`
3. `Dialog`
4. `AlertDialog`
5. `Avatar`
6. `Badge`
7. `Input`
8. `Textarea`
9. `Switch`

Rules:

1. Keep these registry-backed in `components/ui/*`.
2. Do not move app-specific logic into registry files.
3. Compose app behavior in `components/profile/*`, `components/app-ui/*`, or feature folders.

## Do / Don’t

### Do

1. Reuse `SettingsGroup` and `SettingsRow` for new settings screens.
2. Keep descriptions concise and stateful.
3. Open dense workflows in drawers or sheets.
4. Use a right-aligned `Switch` for binary settings like visibility.
5. Keep row actions visually balanced with the left icon block.
6. Center the left icon against the full title-plus-subtitle block so it spans the whole heading unit, not just the first line.
7. Add `MaterialRipple` to every actionable card surface, not only buttons.

### Don’t

1. Don’t build a new settings page out of generic cards.
2. Don’t mix multiple row styles in one surface.
3. Don’t put long helper paragraphs directly inside root groups.
4. Don’t let trailing controls wrap below the row unless the design explicitly calls for it.
5. Don’t edit shadcn registry primitives for app-specific styling logic.
6. Don’t use generic sparkle icons as the fallback symbol for “smart”, “optimize”, or onboarding states.

## Implementation Reference

Primary files:

1. `hushh-webapp/components/profile/settings-ui.tsx`
2. `hushh-webapp/app/profile/page.tsx`
3. `hushh-webapp/components/ui/switch.tsx`

Any new settings-like surface should match these patterns before introducing a new abstraction.
