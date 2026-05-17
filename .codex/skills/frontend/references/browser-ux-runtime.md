# Browser UX And Runtime Reference

Use this reference for frontend browser proof, protected-route behavior, local
runtime launches, phone-auth incidents, and compact UX review.

## Verification Choice

1. Use typecheck, route/service tests, and runtime diagnostics first when they
   prove the behavior.
2. Use Playwright only for browser-only behavior: auth/bootstrap, vault unlock,
   protected-route gating, navigation, responsiveness, animation, or
   interaction defects.
3. Run browser automation only when requested or when no cheaper proof is
   authoritative.

## Protected Routes

1. The vault key is memory-only.
2. Next client navigation preserves unlocked state.
3. Full document navigations and raw `page.goto(...)` reset React memory and
   may require re-unlock.
4. Signed-in Playwright proof defaults to reviewer-mode login, vault unlock via
   maintainer-only secret overlay, and real in-app clicks for route coverage.
5. Use direct deep links only for cold-entry, redirect, or re-unlock proof.

## Runtime Launch

1. Default frontend runtime launch is a visible OS terminal window through the
   canonical repo command.
2. Use inline long-lived Codex sessions only when the user explicitly asks for
   inline or in-Codex logs.
3. Use the combined stack terminal only when one terminal is explicitly
   preferred.

## Phone Auth Incidents

1. Backend/API logs returning 2xx usually mean Firebase browser auth, not a
   backend route crash.
2. `invalid-app-credential` and `captcha-check-failed` require checking
   authorized domains, API key restrictions, reCAPTCHA config, and active
   origin.
3. `too-many-requests` is Firebase SMS throttling and cannot be fixed by
   frontend retries.
4. Do not change local auth origin as a workaround until vault/passkey origin
   behavior is verified.

## UX Review Kernel

1. Each screen, card, sheet, and modal should answer the user's next question.
2. If a card exposes a count, the detail state should expose concrete items,
   names, states, or reasons.
3. Avoid duplicated headers, repeated framing, card-inside-card layouts, and
   helper copy that does not support action.
4. Rebalance tablet and desktop layouts; do not stretch a mobile stack onto
   wider screens.
5. Close, back, open, and tap states must feel first-class and reliable.
6. Persona-facing copy should use plain language and avoid internal platform
   abbreviations unless the route is developer-facing.
7. Signed-in nested routes should use shared top app bar navigation/actions
   rather than route-local back or unlock chrome.
8. Use standard route headers and surface-specific accents unless a route has a
   semantic reason to diverge.
