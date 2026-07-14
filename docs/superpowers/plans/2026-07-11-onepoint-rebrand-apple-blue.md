# Location Rebrand + Apple Blue Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the existing "One Location" feature to "Location" and replace its warm-gold accent with Apple system blue as the single theme.

**Architecture:** The location feature already exists in full. Business logic (encryption, consent, service calls) lives in `app/one/location/page.tsx` and is passed to pure-presentation components in `components/one-location/redesign/` via a single `LocationHubViewModel`. This change is presentation-only: (1) swap hardcoded gold hex literals for Apple blue across `components/one-location/**`, and (2) rename user-facing "One Location" display strings to "Location". No routes, agent IDs, file names, or storage keys change.

**Tech Stack:** Next.js (App Router), React, TypeScript, Tailwind CSS (arbitrary color values with alpha modifiers), Vitest/Jest + Testing Library.

## Visual Map

```
app/one/location/page.tsx  (business logic: encryption, consent, service calls)
        │  builds
        ▼
  LocationHubViewModel  ──►  components/one-location/redesign/*  (pure presentation)
        │                         ├─ location-redesign-hub.tsx   (Now | People | Links | Inbox)
        │                         ├─ sharing-status-card.tsx     (hero + LIVE/OFF toggle)
        │                         ├─ sos-panel.tsx               (SOS READY → countdown → ALERT ACTIVE)
        │                         └─ check-in-flow.tsx           (task flow)
        ▼
  Theme swap: warm-gold #d4a574 → Apple blue #007aff  (presentation-only)
```

## Global Constraints

- Accent color: `#007aff` (iOS system blue). Dark-mode accent variant: `#4a9eff`. Accent tint surface: `#e7f0fd`.
- Use **direct hex-literal replacement**, NOT CSS variables — Tailwind cannot inject alpha into `var(--x)/12`, and many usages carry alpha modifiers (`bg-[#d4a574]/12`, `ring-[#d4a574]/40`).
- Rename **display copy only**. Do NOT change: route paths (`/one/location`), `agentId` (`agent_location`), file/dir names, localStorage keys (`one_location_onboarding_v1`), component identifiers, or test IDs.
- Do NOT touch already-correct colors: SOS red `#e0342c`/`#d92c24`, live green `#34c759`, neutral `--app-card-*` surfaces.
- Out of scope (later phase): onboarding expansion, coach-mark tour, agents-hub hero restyle, Meeting activation.
- Working directory for all commands: `/Users/gautamahuja/Desktop/RedPlanet/hushh-research/hushh-webapp` unless a path says otherwise.
- Commits: DCO sign-off (`git commit -s`); no Claude co-author trailer.

---

### Task 1: Swap warm-gold accent for Apple blue

**Files:**
- Modify: `components/one-location/redesign/tokens.ts` (the `ACCENT_BLUE` constant + its comment)
- Modify (hex literals): every file under `components/one-location/` containing `#d4a574`, `#b8894d`, `#e6b366`, or `#f7f1e8` — includes `redesign/primitives.tsx`, `redesign/quick-actions.tsx`, `redesign/check-in-flow.tsx`, `redesign/drive-to-flow.tsx`, `redesign/pick-me-up-flow.tsx`, `redesign/safe-arrival-flow.tsx`, `redesign/location-chat-composer.tsx`, `redesign/location-redesign-hub.tsx`, `redesign/sos-panel.tsx`, `activity-dashboard.tsx` (final list resolved by grep in Step 1)
- Test: `components/one-location/redesign/__tests__/cards-primary-theme.test.tsx` (existing — must still pass)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `ACCENT_BLUE = "#007aff"` exported from `tokens.ts` (available for any later work).

- [ ] **Step 1: Inventory every gold occurrence (baseline)**

Run:
```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research/hushh-webapp
grep -rlniE "#d4a574|#b8894d|#e6b366|#f7f1e8" components/one-location
grep -rcE "#d4a574|#b8894d|#e6b366|#f7f1e8" components/one-location | grep -v ':0$'
```
Expected: a list of ~7–10 files with a non-zero total (~116 matches). Record this list — Step 3 must clear all of them.

- [ ] **Step 2: Confirm the existing theme test passes before changes**

Run:
```bash
npx jest components/one-location/redesign/__tests__/cards-primary-theme.test.tsx 2>/dev/null \
  || npx vitest run components/one-location/redesign/__tests__/cards-primary-theme.test.tsx
```
Expected: PASS (it asserts cards contain no `#b8894d`/`#d4a574`). Use whichever runner the repo uses; if unsure, check `hushh-webapp/package.json` `scripts.test`.

- [ ] **Step 3: Replace the gold hex literals with Apple blue**

Run (order matters — do the two multi-file golds, then the two activity-dashboard-only variants):
```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research/hushh-webapp
FILES=$(grep -rlE "#d4a574|#b8894d|#e6b366|#f7f1e8" components/one-location)
# primary accent + accent text -> iOS system blue
perl -pi -e 's/#d4a574/#007aff/gi; s/#b8894d/#007aff/gi;' $FILES
# dark-mode accent text -> lighter blue; tint surface -> blue tint
perl -pi -e 's/#e6b366/#4a9eff/gi; s/#f7f1e8/#e7f0fd/gi;' $FILES
```

- [ ] **Step 4: Fix the `ACCENT_BLUE` token + comment**

In `components/one-location/redesign/tokens.ts`, ensure the constant is:
```ts
// Primary accent — iOS system blue (Apple Blue v2 design).
export const ACCENT_BLUE = "#007aff";
```
Replace whatever gold value/comment currently sits there (it previously read `"#b8894d"` with a "foundation-gold-deep" comment; Step 3 already rewrote the value to `#007aff`, so this step just corrects the comment wording).

- [ ] **Step 5: Verify no gold remains**

Run:
```bash
grep -rniE "#d4a574|#b8894d|#e6b366|#f7f1e8" components/one-location; echo "exit=$?"
```
Expected: no output, `exit=1` (grep found nothing). If any hits remain, add those files to the set and re-run Step 3.

- [ ] **Step 6: Verify blue is present**

Run:
```bash
grep -rcE "#007aff" components/one-location | grep -v ':0$'
```
Expected: the same files from Step 1 now contain `#007aff`.

- [ ] **Step 7: Run the theme test + typecheck**

Run:
```bash
npx jest components/one-location 2>/dev/null || npx vitest run components/one-location
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS / no type errors. `cards-primary-theme.test.tsx` still passes (gold still absent; it does not assert a positive gold value).

- [ ] **Step 8: Commit**

```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research
git add hushh-webapp/components/one-location
git commit -s -m "style(location): replace warm-gold accent with Apple blue"
```

---

### Task 2: Rebrand user-facing "One Location" → "Location"

**Files:**
- Modify: `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx`
- Modify: `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx`
- Modify: `hushh-webapp/lib/onboarding/one-capabilities.ts` (the `id:"location"` entry, ~line 130–140)
- Modify: `hushh-webapp/app/one/location/page.tsx`
- Modify: `hushh-webapp/lib/consent/location-consent.ts`
- Modify: `hushh-webapp/components/consent/consent-center-page.tsx`
- Modify: `hushh-webapp/app/one/location/invite/[token]/page-client.tsx`

**Interfaces:**
- Consumes: `ACCENT_BLUE` from Task 1 is unrelated; no cross-task dependency.
- Produces: user-facing brand string "Location" (no exported symbols).

- [ ] **Step 1: Baseline — list remaining user-facing "One Location" strings**

Run:
```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research/hushh-webapp
grep -rniE "one location" app components lib --include="*.tsx" --include="*.ts" \
  | grep -viE "__tests__|\.test\.|/out/|^\s*(//|\*)|one[-_]location"
```
Expected: the set of display strings listed in the spec (hub title, chat bot name ×2, roster tile, page aria-labels ×4, consent copy, invite copy). Comments and identifiers are filtered out and must be left alone.

- [ ] **Step 2: Rename the hub header**

`components/one-location/redesign/location-redesign-hub.tsx` line 436:
```tsx
        title="Location"
```
(was `title="One Location"`)

- [ ] **Step 3: Rename the chat bot name (both occurrences)**

`components/one-location/redesign/location-chat-panel.tsx` lines 59 and 74 — change each bot-name label:
```tsx
            <p className="text-sm font-semibold text-foreground">Location</p>
```
(was `>One Location<`)

- [ ] **Step 4: Rename the agents-hub roster tile**

`lib/onboarding/one-capabilities.ts`, the entry with `id: "location"` / `agentId: "agent_location"`:
```ts
    id: "location",
    agentId: "agent_location",
    title: "Location",
    description: "Live location & Alerts",
    previewLabel: "Live location & Alerts",
    href: ROUTES.ONE_LOCATION,
    icon: MapPin,
    tone: "location",
```
Change only `title`, `description`, `previewLabel`. Leave `id`, `agentId`, `href`, `icon`, `tone` unchanged.

- [ ] **Step 5: Rename the page aria-labels / sr-only heading**

`app/one/location/page.tsx`:
- line 1200: `aria-label="How Location works"`
- line 1251: `aria-label="How Location keeps you safe"`
- line 1431: `aria-label="Loading Location"`
- line 5267: `<h2 className="sr-only">Location Agent</h2>`

- [ ] **Step 6: Rename user-facing consent + invite copy**

- `lib/consent/location-consent.ts:112` — the returned string:
```ts
  return `${who} wants to see your location through Location.`;
```
- `components/consent/consent-center-page.tsx:1040`:
```tsx
            description="Review this location request, active access, and expiry in Location."
```
- `app/one/location/invite/[token]/page-client.tsx:279` — the text node:
```tsx
                encrypted share from Location.
```

- [ ] **Step 7: Verify no user-facing "One Location" strings remain**

Run:
```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research/hushh-webapp
grep -rniE "one location" app components lib --include="*.tsx" --include="*.ts" \
  | grep -viE "__tests__|\.test\.|/out/|^\s*(//|\*)|one[-_]location"; echo "exit=$?"
```
Expected: no display-string hits. Any remaining lines must be comments/identifiers only (verify by eye). Note: `/one/location` routes, `agent_location`, and `one_location_*` keys are intentionally retained.

- [ ] **Step 8: Run tests + typecheck**

Run:
```bash
npx jest components/one-location app/one/location 2>/dev/null \
  || npx vitest run components/one-location app/one/location
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS / no type errors. If a test asserts the literal string "One Location", update it to "Location".

- [ ] **Step 9: Commit**

```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research
git add hushh-webapp
git commit -s -m "feat(location): rebrand One Location display copy to Location"
```

---

### Task 3: End-to-end visual verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: the running app with Tasks 1–2 applied.

- [ ] **Step 1: Launch the app and open the location screen**

Use the repo's run workflow (see `AGENTS.md` / `/run`). Reuse the iOS simulator noted in memory (iPhone 16 / iOS 18.2, `B46FD09B-…`) or the web dev server, log in, unlock the vault, and navigate to the Location agent (`/one/location`).

- [ ] **Step 2: Confirm rebrand**

Expected on screen:
- Agents hub tile reads **"Location" / "Live location & Alerts"**.
- Location hub header reads **"Location"**.
- Agent chat card bot name reads **"Location"**.

- [ ] **Step 3: Confirm Apple blue accents**

Expected: primary buttons, active tab pill, focus rings, and accent icons render **Apple blue (`#007aff`)** — no gold anywhere. Check Now/People/Links/Inbox tabs and open one quick-action flow (e.g. Check-In) to confirm blue on selectors/toggles.

- [ ] **Step 4: Confirm untouched colors intact**

Expected: SOS/Alert remains red, "Live" indicators remain green.

- [ ] **Step 5: Final full-suite check**

Run:
```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research/hushh-webapp
npm test 2>&1 | tail -20
```
Expected: suite green (or no new failures vs. the pre-change baseline).
