# The excluded-route reason contract

An `excluded-*` classification drops a route out of **every** parity check. It
was the one place tri-flow could be lost silently: marking a route excluded cost
nothing, recorded nothing, and no reviewer saw why. Before this contract, 16
routes were excluded with zero recorded justification, while the PR template
already demanded the layer be "explicitly marked as not applicable with the
reason".

`verify-native-static-parity.mjs` now fails when an `excluded-*` route carries
no `reason`, or one shorter than 40 characters.

## The two kinds of exclusion

Collapsing this distinction is how a backlog disappears.

**Permanent exclusion — a property of the route.** It would still hold if the
native shells shipped tomorrow.

> `/oauth/authorize` — OAuth authorization must complete in a system browser.
> Providers reject embedded webviews, so a native surface would break the flow
> rather than improve it.

> `/one/puppy` — Puppy One requires a loopback connection to the Mac running the
> local model. A phone cannot reach 127.0.0.1 on another device, and the bridge
> key is host remote-code-execution, so forwarding it off-machine is refused by
> design.

**A gap — a property of the current native shell.** The route should have a
native surface and does not yet.

> `/one/calendar` — GAP, not a permanent exclusion. Calendar is a first-class
> One agent and should have a native surface; it does not have one yet.
> Excluding it hides that. Revisit before the next native release.

Write `GAP, not a permanent exclusion` and name what would close it.

## Why a bad reason is worse than none

A blank field invites a second look. A good-sounding sentence stops one. That
asymmetry is the whole risk: the field cannot make anyone honest, it can only
make dishonesty legible, and a laundered gap is illegible by construction.

## Judging a reason

Adequate means: a reviewer who has never seen the route can tell whether the
exclusion should still hold next quarter.

1. **Does it name a concrete constraint, or restate the classification?**
   "Web only" is a restatement of `excluded-web-only`. It adds nothing.
2. **If the constraint vanished, would the route become native-required?**
   If yes, it is a gap and must say so.
3. **Is the constraint about the route, or about the current state of the
   native shell?** The second is always a gap.

## Categories that are legitimately permanent

- **OAuth legs.** Providers reject embedded webviews; a native surface breaks
  the flow rather than improving it.
- **Compatibility redirects.** The redirect target carries the parity
  obligation, not the redirect.
- **Public marketing and content pages.** The native shell ships the signed-in
  product; the public site is web.
- **Operator and lab surfaces.** Not shipped to app users at all.
- **Loopback-dependent surfaces.** A phone cannot reach a service bound to
  127.0.0.1 on a different machine.

Anything outside these deserves a hard look before it is called permanent.

## What this does not verify

The static gate checks the **declaration**, not the running app. A route marked
`native-required` with a correct `expectedMarker` can still be broken on a
device; that is `mobile-parity-audit`'s job and it needs hardware.

Static parity is the cheap gate that runs on every change, and it catches the
failure that costs most to find late: a route that was never declared at all.
