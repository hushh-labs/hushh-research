# Location Rebrand + Apple Blue Theme — Design Spec

**Date:** 2026-07-11
**Status:** Approved (Phase 1)
**Source design:** `Location Agent - Apple Blue v2.dc.html` (Downloads/Location agent features (3))

## Visual Map

```
"One Location"  ──rebrand──►  "Location"        (display copy only)
warm-gold #d4a574  ──restyle──►  Apple blue #007aff (theme only)

Surfaces restyled (presentation layer, components/one-location/redesign/*):
  hub (Now | People | Links | Inbox) · Check-In · SOS/Alert · Drive To
  Pick Me Up · Safe Arrival · live map · sharing links · Inbox · invite · chat

Unchanged: routes, agent IDs, file names, storage keys, business logic.
```

## Problem / Context

A new design ("Location / Apple Blue v2") rebrands and restyles the location
product. Investigation confirmed the location feature **already exists in full**
in the codebase under the name **"One Location"** — the Now/People/Links/Inbox
hub, Check-In, SOS/Alert, Drive To, Pick Me Up, Safe Arrival, live map, sharing
links, Inbox, invite code, onboarding, and agent chat are all built. The string
"Location" appears nowhere today.

Therefore this is a **rebrand + restyle of an existing feature**, not a new
build. All business logic (encryption, consent, service calls, analytics) is
centralized in `app/one/location/page.tsx` and passed to pure-presentation
components in `components/one-location/redesign/` via a single
`LocationHubViewModel`. The visual change touches presentation only and is
low-risk.

## Scope (Phase 1)

In scope:
1. Rebrand user-facing "One Location" → **"Location"**.
2. Replace the warm-gold accent with **Apple system blue** as the single theme.

Explicitly **out of scope** (deferred to a later phase):
- Location onboarding expansion (add-people, invite-code, 3-way permissions
  Location/Notifications/Motion, SOS-recipient setup).
- Coach-mark tour ("Find your way around").
- Agents-hub hero restyle ("hussh One." greeting + setup-progress card).
- Meeting flow activation (remains a "coming soon" stub, matching the design).

## Design

### A. Rebrand: "One Location" → "Location" (display copy only)

Rename user-facing strings **only**. Do NOT change: route paths
(`/one/location`), `agentId` (`agent_location`), file/directory names,
localStorage keys (`one_location_onboarding_v1`), component identifiers, or test
IDs.

| File:line | Current | New |
|---|---|---|
| `components/one-location/redesign/location-redesign-hub.tsx:436` | `title="One Location"` (hub header) | `title="Location"` |
| `components/one-location/redesign/location-chat-panel.tsx:59` | `>One Location<` (bot name) | `>Location<` |
| `components/one-location/redesign/location-chat-panel.tsx:74` | `>One Location<` (bot name) | `>Location<` |
| `lib/onboarding/one-capabilities.ts:134` | `title:"Location"` | `title:"Location"` |
| `lib/onboarding/one-capabilities.ts` (same entry) | `description:"Live sharing, referrals, and local context."` / `previewLabel:"Live sharing & local context"` | `description:"Live location & Alerts"` / `previewLabel:"Live location & Alerts"` |
| `app/one/location/page.tsx:1200` | `aria-label="How One Location works"` | `...Location works` |
| `app/one/location/page.tsx:1251` | `aria-label="How One Location keeps you safe"` | `...Location keeps you safe` |
| `app/one/location/page.tsx:1431` | `aria-label="Loading One Location"` | `Loading Location` |
| `app/one/location/page.tsx:5267` | `<h2 class="sr-only">One Location Agent</h2>` | `Location Agent` |
| `lib/consent/location-consent.ts:112` | `"...wants to see your location through One Location."` | `...through Location.` |
| `components/consent/consent-center-page.tsx:1040` | `"...expiry in One Location."` | `...in Location.` |
| `app/one/location/invite/[token]/page-client.tsx:279` | `"encrypted share from One Location."` | `...from Location.` |

Note: the agents-hub tile `tone:"location"` (Sage Green pin icon) stays as-is —
that is the agent's brand icon in the roster and is independent of the location
feature's internal accent.

### B. Apple Blue theme (replace warm-gold)

Straight **hex-literal replacement** across `components/one-location/**`. A
direct literal swap (not a CSS variable) is required because many usages are
Tailwind arbitrary values with alpha modifiers (e.g. `bg-[#d4a574]/12`,
`ring-[#d4a574]/40`); Tailwind cannot inject alpha into `var(--x)/12`, so a
variable would break those.

Palette (from the Apple Blue v2 design — `#007aff` is the dominant accent, 175
uses):

| Current (gold) | New (Apple blue) | Meaning |
|---|---|---|
| `#d4a574` | `#007aff` | primary accent / button bg / tint |
| `#b8894d` | `#007aff` | accent text |
| `#e6b366` (dark-mode variant, activity-dashboard) | `#4a9eff` | accent text, dark mode |
| `#f7f1e8` (tint bg, activity-dashboard) | `#e7f0fd` | accent tint surface |

Also update the design-token constant:
- `components/one-location/redesign/tokens.ts` — set `ACCENT_BLUE = "#007aff"`
  and correct the comment that currently claims it is "foundation-gold-deep".

Affected files (approx. 116 occurrences across ~7 files):
`location-redesign-hub.tsx` (via primitives/tokens), `tokens.ts`,
`primitives.tsx`, `quick-actions.tsx`, `check-in-flow.tsx`, `drive-to-flow.tsx`,
`pick-me-up-flow.tsx`, `safe-arrival-flow.tsx`, `location-chat-composer.tsx`,
`activity-dashboard.tsx`.

Colors intentionally **left unchanged** (already match the design):
- SOS/alert red `#e0342c` / `#d92c24`
- live/success green `#34c759`
- neutral surfaces routed through the app-wide `--app-card-*` system

## Verification

1. `grep -rniE "#d4a574|#b8894d|#e6b366|#f7f1e8" components/one-location` → no
   hits.
2. `grep -rni "One Location" app components lib --include=*.tsx --include=*.ts`
   (excluding tests/comments/`out/`) → no user-facing display strings remain.
3. Run the location test suite. Note: `cards-primary-theme.test.tsx` asserts the
   *absence* of `#b8894d`/`#d4a574` (that cards don't hardcode gold) — it keeps
   passing after the swap to blue, no update needed. Watch for any other test
   asserting the literal gold value positively.
4. Drive the location screen in the app and confirm accents render Apple blue and
   the header/chat/roster read "Location".

## Risks

- Low. Presentation-only; logic isolated behind `LocationHubViewModel`.
- Existing theme test (`cards-primary-theme.test.tsx`) asserts absence of gold,
  so it survives the swap. Watch for any other test that asserts the gold hex
  positively; update such a test to the new blue value rather than deleting it.
