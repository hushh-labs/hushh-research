# Browser Verification Contract

Use this reference when a verification policy depends on browser behavior,
protected routes, or cross-surface proof selection.

## Proof Selection

1. Start from the contract or user-facing behavior that needs proof.
2. Prefer unit, integration, route, service, and type checks when they are
   authoritative.
3. Use Playwright only when behavior depends on a real browser.
4. Keep required verification lean and changed-surface specific.

## Browser-Only Cases

Use browser proof for:

1. auth/bootstrap and reviewer-mode flows
2. vault unlock and protected-route gating
3. Next client navigation behavior
4. responsive layout, animation, interaction, or browser runtime issues

## Protected Routes

1. Split same-session client navigation after unlock from cold-entry or direct
   deep-link re-auth/re-unlock behavior.
2. Do not let one script conflate the two contracts when vault state is
   memory-only.
3. Signed-in protected route proof defaults to reviewer-mode login, vault
   unlock via maintainer-only secret overlay, and Next client navigation.
4. Reviewer-mode proof must resolve the active reviewer from `REVIEWER_UID`
   in the backend/runtime env and assert that the browser auth session, vault
   owner token, workflow owner, and PKM data owner all refer to that user. With
   the flipped Email Helper data model, copied recipients and counterparties
   are not proof identities.
5. Raw `page.goto(...)` to a protected route is cold-entry proof only.
6. A route-memory test must prove the navigation mechanism and fail on hard
   reloads, `window.location` hops, direct route jumps, or full-document
   navigations.
7. Keep Playwright base URL, webServer URL, and dev-server port aligned.

## PKM And Data Contracts

1. For PKM work, verify the same user across manifest-backed backend metadata,
   helper/service metadata, MCP discovery payload, and user-visible rendering.
2. If reviewer fixture data is missing for the env-wired user, repair or reseed
   that user instead of switching proof to another UID or email.
3. A locked summary rendering as empty PKM is a regression unless stored PKM is
   actually empty.
4. For new or repurposed database tables, include the repo data-model audit in
   verification.
5. Treat modularity findings as test-selection prompts, not failures by
   themselves.
