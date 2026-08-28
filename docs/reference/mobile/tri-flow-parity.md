# Tri-flow parity

Tri-flow is **Web + iOS + Android**. Every layer of a change is either covered
or explicitly marked not-applicable **with a reason**. Silent omission is not a
third option.

## Where the claim lives

Not in the PR checkbox. A tick in a template is not reviewable six months
later, and nothing reads it.

The claim lives in `hushh-webapp/native-route-inventory.json`, one row per
route, and `scripts/native/verify-native-static-parity.mjs` enforces it.

| Classification | Meaning | Required field |
| --- | --- | --- |
| `native-required-*` | The native shells must render this route | `expectedMarker` |
| `excluded-*` | The native shells are not expected to render it | `reason` (min 40 chars) |

Both requirements fail the build when unmet.

## Why the reason field exists

An `excluded-*` classification drops a route out of **every** parity check. It
was the one place tri-flow could be lost silently: marking a route excluded cost
nothing, recorded nothing, and no reviewer saw why.

Before this contract, 16 routes were excluded with zero recorded justification.
The PR template already demanded the layer be "explicitly marked as not
applicable with the reason"; nothing carried that reason anywhere a person or a
script could read it.

## The two kinds of exclusion

This distinction is the whole point. Collapsing it is how a backlog disappears.

**A permanent exclusion is a property of the route.** It would still hold if
the native shells were finished tomorrow.

> `/oauth/authorize` — OAuth authorization must complete in a system browser.
> Providers reject embedded webviews, so a native surface would break the flow
> rather than improve it.

**A gap is a route that should have a native surface and does not yet.** It is
a property of the current state of the app, not of the route.

> `/one/calendar` — GAP, not a permanent exclusion. Calendar is a first-class
> One agent and should have a native surface; it does not have one yet.
> Excluding it hides that. Revisit before the next native release.

Say `GAP, not a permanent exclusion` in the reason, and name what would close
it. A plausible-sounding justification is **worse** than a blank field, because
a blank field invites a second look and a good-sounding sentence stops one.

## Judging a reason

A reason is adequate when a reviewer who has never seen the route can tell
whether the exclusion should still hold next quarter.

1. **Does it name a concrete constraint, or restate the classification?**
   "Web only" is a restatement. It says what the field already said.
2. **If the constraint vanished, would the route become native-required?**
   If yes, it is a gap and must say so.
3. **Is the constraint about the route, or about the current state of the
   native shell?** The second is always a gap.

## Adding a route

1. Add it to `ROUTES`.
2. Classify it in `native-route-inventory.json` in the **same change**.
3. `native-required` gets an `expectedMarker`; `excluded-*` gets a `reason`.
4. Run the static gate. It is fast and needs no device:

```bash
cd hushh-webapp && node scripts/native/verify-native-static-parity.mjs
```

## Current exclusions

16 routes, all with reasons. Two are recorded as gaps rather than permanent
exclusions: `/one/calendar` and `/one/setup/calendar`. Those are real debt, and
they are visible now instead of being absorbed into a classification.

## What this does not verify

The static gate checks the **declaration**, not the running app. A route marked
`native-required` with a correct `expectedMarker` can still be broken on a
device. That is `mobile-parity-audit`'s job, and it needs a simulator or
hardware.

Static parity is the cheap gate that runs on every change. It catches the
failure that costs the most to find late: a route that was never declared at
all.
