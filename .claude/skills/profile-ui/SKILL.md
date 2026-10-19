---
name: profile-ui
description: Apply the approved Profile typography, icon and divider design to one named page at a time. Use when asked to "make X match Profile", "use the Profile font sizes", or to restyle a page's headers, section labels, row labels and supporting text to the Profile scale. Maps the page's elements to Profile roles by purpose, applies the verified values from the reference, and reports the mapping with before/after proof. Not for building new components, changing page layout, or editing Profile itself.
argument-hint: <page name or route> [all]
---

# profile-ui

Profile is the visual authority for type hierarchy. This skill carries it to one page per run.
Every measured value (sizes, weights, line heights, tracking, colors, spacing, icon and divider
specs) is in [references/profile-reference.md](references/profile-reference.md). **Read it first
and take every number from it. This file holds none.** Keep the reference unchanged unless the
user asks for an update, and then re-measure instead of editing by hand.

## Invocation

```
/profile-ui Connect
/profile-ui Connect all
```

The page is named by the user (name or route). Typography is the default scope. Add `all` to
include leading icons, chevrons and dividers. One page per run.

## Procedure

1. **Orient.** Read the repo instructions, record the current branch and `git status` (preserve
   existing edits), and read the target's source and any owning `.voice-action-contract.json`.
   Run `cd hushh-webapp && npm run ui:doctor` before editing a screen.
2. **Measure the "before".** Capture the target at 320, 390, 430, 768 and 1280px, plus 200%
   enlargement, and record the computed font size, weight, line height, tracking and color of
   each element you will touch.
3. **Map by purpose and hierarchy, not by tag or class.** Write the mapping table first
   (section "Mapping output"). Use the reference's role table: surface header, header
   description, identity name and meta, section subtitle, navigation-row label, row
   description, leading icon, chevron, divider. Pick the **home** variant for a menu-like
   list page and the **detail** variant (reference section 7) for a form or detail page.
4. **Flag, do not invent.** If a page element has no Profile role (tabs, buttons, inputs,
   search, chips, tables, numbers, empty states, toasts, long-form body text), leave it
   as is and list it as `no Profile role`. Never force a match, and never give static text
   the look of a tappable row label.
5. **Apply once, through shared tokens.** See "How to apply" below. No per-page copies of a
   value.
6. **Verify**, then report (sections below). Do not push, merge or deploy.

## How to apply

Cascade authority is the trap (reference section 8). The Profile scale wins through an
`@layer base` block with `!important`, because earlier-layer important declarations beat
unlayered ones. A rule written the obvious way loses silently.

1. Prefer what already exists: the `data-slot` hooks that `SettingsGroup` and `SettingsRow`
   emit (`settings-group-heading`, `settings-row-title`, `settings-row-description`,
   `settings-row-icon`, `settings-row-chevron`), the semantic components in
   `components/app-ui/typography.tsx`, and the `--app-side-pane-*` tokens.
2. Scope by one opt-in attribute on the target page's root, `data-profile-type-scale`.
   `grep -n "data-profile-type-scale" hushh-webapp/app/globals.css` first. If the block exists, only add the
   attribute to the page. If not, add the two pieces below, once.
   - **Share the tokens.** The `--app-side-pane-*` tokens are declared only on the pane and
     drawer selectors (`globals.css:2199-2215`), so another page reads them as undefined and its
     text collapses to the inherited size. Add `[data-profile-type-scale]` to that selector
     list. Do not redeclare the values.
   - **One block in `@layer base`**, after the existing base blocks, using `!important` and a
     four-part selector such as
     `.app-page-shell [data-profile-type-scale] [data-row-layout] [data-slot="settings-row-title"]`
     (same shape for `settings-group-heading` and `settings-row-description`), consuming the tokens.
3. For roles whose Profile values are literals with no token (header, description, identity),
   add tokens once, next to the existing `--app-side-pane-*` set. Do not rewire Profile's
   own rules.

Proven on 2026-10-18 in a throwaway harness (a plain list page, comfortable and compact
rows): the opted-in subtree computed exactly the reference group label, row label and row
description values while an untouched sibling kept the app-wide scale. The same block written
unlayered changed nothing, and the layered block without the shared tokens fell back to
the inherited 16px. Re-prove each of these with computed style on the target.
4. Never select `.profile-home-content`, `.profile-pane-*` or `[data-app-side-pane]` from
   another page. Those selectors also carry Profile geometry (row geometry, glass cards).
5. Never change the default look of `SettingsGroup`, `SettingsRow`, `SectionLabel`, `RowLabel`
   or `RowDescription`, and never edit the `--app-side-pane-*` values: Profile and the Chats
   drawer share them. A shared change must be invisible to untargeted pages. Confirm by
   grepping every consumer and screenshotting one of them.
6. Keep page architecture, routing, APIs, state, content, interactions and layout. Typography
   edits do not move or resize controls other than through natural text wrapping.
7. Where weight 500 or 800 is specified, set it, then report the painted face. Only 400, 600
   and 700 ship (550 paints SemiBold, 500 paints Regular).

## Resizing and wrapping (required)

- Check long content (a 60-character name, a long email, a long description) at 320, 390,
  430, 768 and 1280px and at 200% enlargement.
- Text wraps naturally (`overflow-wrap: anywhere`, no clipping, no ellipsis that hides content).
  Fix a local overflow by changing the container (min-width, wrapping, padding). Never shrink the
  text to fit and never hide it.
- Check `document.documentElement.scrollWidth - clientWidth` is 0 and no row clips.
- The smallest Profile roles are tiny and low-contrast (reference section 9). Report
  them for every page, with the 200% result.

## Verification

- Computed-style check of every changed role against the reference (the probe in reference
  section 10 is a template). Report the painted font face, not just `font-weight`.
- Before/after screenshots at the same viewport and state. Auth-gated pages cannot be signed in by an
  agent; use the signed-in session the user opened, or the repo's fixture pattern
  (`e2e/profile-legal-connectors.layout.spec.ts`: Vite bundle plus compiled `globals.css`).
- `cd hushh-webapp && npm run ui:doctor`, then `npm run build:ui-contracts` and
  `npm run verify:ui-contracts` when a screen's imported UI changed, plus the page's own
  tests and `npx tsc --noEmit` / lint on touched files. Add a test only for a real contract,
  and extend the nearest existing test file.
- Say plainly what was not verified (dark scheme, iOS WebKit, signed-in data).

## Mapping output

Return this table before any edit, then again with the result.

| Page element (file:line) | Purpose and hierarchy | Profile role | Applied values (from the reference) | Notes |
|---|---|---|---|---|

Then: changed files, matching before/after screenshots, verification results, unmapped
elements (`no Profile role`), and open risks. No Co-Authored-By trailer in any commit message.
