---
name: location-header-system
description: The header contract for every One Location screen — the top-bar breadcrumb, the single back control, and the eyebrow/title pair. Use when adding, renaming, or redesigning any Location surface (a new `?action=` flow, a `/one/location/*` route, a check-in or SOS or settings screen), when a screen shows two back buttons, when a screen has no breadcrumb, when a breadcrumb label disagrees with the on-screen title, or when a Location flow renders full-bleed over the app shell. Also use before changing `oneLocationActionLabel` or any Location `TaskFlowHeader`.
---

# One Location header system

**A Location screen has exactly one back control, one breadcrumb, and one title — and the breadcrumb's last crumb is that title.**

Every screen under `/one/location` is a *task flow inside the signed-in shell*, not a
screen of its own. The shell already draws the top bar, the back control, and the
breadcrumb. A flow that draws any of those itself produces the two bugs this skill
exists to prevent: a screen with **no breadcrumb**, and a screen with **two back
buttons**.

The Location Settings flow is the reference implementation. Copy it.

---

## The three layers, and who owns each

A Location screen's header is assembled from three places. A flow author writes
**only** the third.

| Layer | Owner | File |
|---|---|---|
| 1. Top bar chrome (back arrow, avatar, container) | Shell | `components/app-ui/top-app-bar.tsx` |
| 2. Breadcrumb trail + back target | Route config | `lib/navigation/top-shell-breadcrumbs.ts` |
| 3. Eyebrow + title + description | The flow | `TaskFlowHeader` in `lib/morphy-ux/ui/surface-primitives.tsx` |

Layer 2 is derived from the URL, not from the component. `resolveTopShellBreadcrumb()`
reads `pathname` + `searchParams` and returns `{ backHref, items, width, align }`.
A component cannot influence it, and must not try.

---

## The contract

### 1. Render inside the shell. Never over it.

```tsx
// ✅ A Location flow
<section data-testid="one-location-thing">
  <TaskFlowHeader eyebrow="Location" title="Thing" />
  …
</section>
```

```tsx
// ❌ Escapes the shell — kills the breadcrumb and the top-bar back button
<section className="fixed inset-0 z-[540] h-[100dvh] bg-black text-white">
```

Any of `fixed inset-0`, an explicit `z-[…]`, `h-[100dvh]`, or a forced canvas color on a
flow root means the flow has left the shell. The top bar is still mounted underneath,
but it is now covered — so the user sees a screen with no trail and no way back except
whatever the flow drew for itself.

This is exactly what SOS did until PR #5251.

### 1b. Check the shell rule too — a component fix cannot reach it

There is a second, higher place a screen can lose its header, and it is the one that
wastes an afternoon: **the shell can be told to blank the chrome for a specific
`?action=` value.** Until PR #5253, `app-route-layout.ts` exported
`shouldSuppressPersistentChromeForRouteState`, which returned `true` for `sos` and
`sms-contacts`. `providers.tsx` OR-ed it into `hidesPersistentChrome`.

The failure mode: you remove the overlay from the component, every test passes, the
screen is perfectly in-flow — and it still renders with **no back control, no trail and
no avatar**, because the shell never mounted them. Nothing in the component is wrong.

So when a Location screen has no header, check **both** layers before editing anything:

```bash
grep -rn "persistentChrome\|SuppressPersistentChrome" hushh-webapp/lib/navigation hushh-webapp/app/providers.tsx
grep -n "fixed inset-0\|100dvh\|z-\[" <the flow component>
```

Chrome visibility is a property of the **route**, declared once as
`persistentChrome` in `app-route-layout.contract.json` where it sits beside every other
route's. It is never a property of the `?action=` flow open inside that route. "It is an
emergency screen so it owns the viewport" is the argument that produced this bug; an
emergency is not a reason to make someone re-learn how to leave a screen.

**Corollary:** once the shell owns the canvas, the flow cannot hardcode dark-only
colors. Use `foreground` / `muted-foreground` / `border` / `--app-card-surface-compact`
/ `--app-destructive`, never `text-white`, `bg-black`, `#1c1c1e`, `#ff3b30`. A
dark-only flow is invisible in light mode.

### 2. The top bar owns back. The flow draws none.

The in-content back arrows were deliberately removed across Location to fix a
"two back buttons" UX. Do not add one back.

```tsx
// ❌ never in a Location flow
<button aria-label="Back to Location"><ChevronLeft /></button>
<TaskFlowHeader onBack={…} />   // the onBack prop exists for non-Location callers
```

A **Cancel** button at the bottom of the flow is fine and is not a back control — it is
a decision ("do not do this thing"), and it may do more than navigate (SOS's Cancel
also stops a live share).

`resolveTopShellBreadcrumb` computes the back target for you, including the cases a
component could not know about:

- strips `?action=` to return to the hub;
- preserves the originating hub tab via `?view=` (opened from **Links** → back to
  **Links**, not to the default **Now** tab);
- `sms-contacts` retraces to `?action=settings`, because that is its only entry point;
- a nearby private check-in returns to the map, not the hub;
- `?from=/one/profile` swaps the first crumb to **Profile**.

### 3. Eyebrow = route name. Title = screen name. Title = last crumb.

```tsx
<TaskFlowHeader
  eyebrow="Location"        // the route the user is inside
  title="SOS"               // this screen — MUST equal the last breadcrumb crumb
  description="Hold to send your live location by SMS."
/>
```

Renders as `One › Location › SOS` in the bar, and `Location` / **SOS** in the content.

The eyebrow is optional — Shared with me, Active shares and Save my Soul ship without
one. **The title matching the last crumb is not optional.** That agreement is what makes
the trail and the screen read as the same place.

Never write a route-local `<h1>`. `TaskFlowHeader` owns the `<h1>` and applies
`SCREEN_TITLE` / `EYEBROW` from `lib/morphy-ux/tokens/surfaces.ts`.

### 3a. Importing a Claude Design screen

When a flow's body comes from a Claude Design file, the design's own header row is
**not** part of what you implement — the shell already draws back, trail and avatar.
Map it instead:

| In the design | Where it goes here |
|---|---|
| the screen's title text | `TaskFlowHeader title` (and the crumb) |
| top-right actions (`+ Contacts`, `Cancel`) | a right-aligned row under the header |
| its `<body>` background | delete it; the shell owns the canvas |
| Inter / Geist / any bundled family | delete it; inherit `--font-app-*` (SF stack) |
| literal hexes and rgba values | promote to `--<screen>-*` tokens in `globals.css`, declared under **both** `:root` and `.dark` |
| `@keyframes` in a `<style>` block | `app/globals.css`, with a reduced-motion guard |

The design is authored at one width on a near-black canvas. Its values are therefore the
**dark** half of your token pair; you still owe the light half, or the screen is blind
in light theme. And size the artwork off one source — the SOS ring scales through a
single `viewBox` with `vector-effect="non-scaling-stroke"` rather than carrying a
second hardcoded copy per breakpoint, which is how mobile and desktop drift apart.

### 4. Adding a flow means editing two files, not one

A new `?action=<slug>` needs a crumb label or the breadcrumb falls back to a titleized
slug (`private-check-in` → "Private Check In" — wrong dash, wrong casing).

```ts
// lib/navigation/top-shell-breadcrumbs.ts → oneLocationActionLabel()
const labels: Record<string, string> = {
  …
  "my-new-flow": "My New Flow",   // must equal the flow's TaskFlowHeader title
};
```

Then add the case to `__tests__/utils/top-shell-breadcrumbs.test.ts`, which asserts the
full `action → label` table.

---

## Current state of every Location surface

Audited at PR #5251. Fix drift when you touch a row, don't leave it.

| Surface | Crumb | On-screen title | Eyebrow | Status |
|---|---|---|---|---|
| `/one/location` (hub) | Location | Location Agent | — | Hub, uses `PageHeader` — not a flow |
| `?action=settings` | Settings | Settings | `Location` | ✅ **reference implementation** |
| `?action=sos` | Save my Soul | Save my Soul | *none* | ✅ fixed in #5251 |
| `?action=shared-with-me` | Shared with me | Shared with me | `Location` | ✅ |
| `?action=active-shares` | Active shares | Active shares | `Location` | ✅ |
| `?action=needs-review` | Needs my review | Needs my review | `Location` | ✅ |
| `?action=check-in` | Check-In | Check-In | `Location` | ✅ |
| `?action=sms-contacts` | SMS contacts | SMS contacts | *none* | ✅ fixed in #5253 |
| `?action=share` | Share location | Who can see you? / Ready to share? | `Step 1 of 2 · …` | 🟡 **deliberate exception** — see below |
| `?action=ask` | Request location | Request location | `Location` | ✅ |
| `?action=invite` | Invite to Circle | Invite to Circle | `Invite to One / Circle` | ⚠️ title ✅, eyebrow is a tagline |
| `?action=temp-link` | Public link | Public location link active / Share outside your Circle | `Copy, share or revoke` / *none* | ⚠️ two titles, neither is the crumb |
| `/one/location/map` | Your Map | — | — | Map route, own chrome |

Every row in this table now uses `TaskFlowHeader`. Check-In was the last one drawing
its own `<h1>` — a local 28px/bold instead of the shared `SCREEN_TITLE` token — and
was fixed the same way SOS was.

Note what `sms-contacts` needed on top of the component fix. Its back target is not the
hub — it is reachable from Settings *and* from the middle of an SOS, and returning that
second person to Settings drops them out of the emergency flow at the worst possible
moment. The hub records the origin as `?source=sos`; `resolveSmsContactsBackAction` in
`top-shell-breadcrumbs.ts` is the single implementation of that rule, and the hub's
`resolveSmsContactsBackFlow` delegates to it. **When you delete a flow's in-content back
button, check what that button knew that the breadcrumb does not** — a hardcoded
`backHref` will silently lose it.

### The one deliberate exception: Share location

`?action=share` keeps "Who can see you?" and "Ready to share?" as its titles under
a `Share location` crumb. That breaks the title-equals-crumb rule, and it is a
product decision, not drift: the supplied design for that screen leads with the
question, and the two steps are told apart by their titles rather than by the
eyebrow alone. `shareStep` is component-local state and never reaches the URL, so
the crumb could not track the step even if it wanted to.

Do not "fix" this row without the design owner. Every other flow in the table
follows the rule, and a second exception should have to argue for itself.

### The eyebrow is being used two ways

This is the real inconsistency underneath the drift. Settings and SOS use the eyebrow
for the **route** (`Location`). Share, Ask, Invite and Temp-link use it for a **step or
tagline** (`Step 1 of 2 · Choose people`, `Request with context`).

Both are defensible in isolation; together they mean the eyebrow tells the user nothing
reliable. When resolving a row: multi-step flows may keep the step in the eyebrow —
a step marker is genuinely more useful mid-flow than repeating the route the breadcrumb
already shows — but a single-screen flow uses `eyebrow="Location"`, and in every case
**the title must equal the crumb.**

---

## Fixing a broken screen

1. Find its `?action=` slug in `ACTION_TO_FLOW` in `location-redesign-hub.tsx`.
2. Confirm its crumb in `oneLocationActionLabel()`. Make it read like the screen title.
3. In the flow component, delete the flow root's overlay classes, any in-content back
   button, and the raw `<h1>`/`<header>`.
4. Add `<TaskFlowHeader eyebrow="Location" title="<crumb>" description="…" />` as the
   first child.
5. Replace hardcoded dark-only colors with theme tokens.
6. Move any inline `<style>` keyframes into `app/globals.css` with a
   `prefers-reduced-motion` guard — a component-level style island is a second motion
   engine, which `lib/morphy-ux/README.md` forbids.

---

## Verify

```bash
cd hushh-webapp
npx vitest run __tests__/utils/top-shell-breadcrumbs.test.ts
npx vitest run __tests__/components/one-location-sos-emergency.contract.test.tsx
npm run verify:design-system     # accent tokens + Apple hierarchy
npm run typecheck
```

The SOS contract test in `__tests__/components/one-location-sos-emergency.contract.test.tsx`
is the template for locking a header fix. It scans the component source, because the
regression it guards is structural rather than behavioral — a screen can render every
control correctly and still be wrong by covering the shell:

```ts
expect(SOURCE).not.toContain("fixed inset-0");
expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
expect(SOURCE).toContain('eyebrow="Location"');
expect(SOURCE).not.toContain("<h1");
expect(SOURCE).not.toContain("ChevronLeft");
```

Copy that block when you fix Check-In and SMS contacts.

**Baseline before you claim green.** The Location suite has pre-existing failures on
`main` (`one-location-onboarding-flow`, `one-location-settings-placement`,
`nearby-check-in-sheet`, `shared-with-me-card`). Run the suite on your branch *and* on
`origin/main`, and compare the failing sets — do not report a count.

Related: `safe-changes`, `hushh-research-ship`, `impeccable`.
