# Design Review Kernel

Use this reference for frontend design-system reviews that need more detail
than the compact skill kernel.

## Ownership

1. Pick the owning layer first: stock UI, Morphy UX, or app-ui.
2. Route-container ownership belongs to `AppPageShell` or
   `FullscreenFlowShell`.
3. Broad route contracts stay with `frontend-architecture`; file placement
   questions stay with `frontend-surface-placement`.

## Layout And Hierarchy

1. Review composition before styling polish.
2. Use components by meaning and evidence density, not convenience.
3. Keep one primary summary card per read and make secondary surfaces additive.
4. Avoid duplicate headers, stacked framing chrome, repeated title treatment,
   and card-inside-card composition unless it adds semantic separation.
5. Rebalance tablet and desktop layouts; wide screens should be recomposed, not
   merely stretched.
6. Detail surfaces should be narrower and more focused than the page shell
   unless real content requires more width.

## Interaction

1. Dialog and sheet close controls must stay clickable above chrome, keep
   content mounted through exit animation, and use the same tactile feedback as
   other actionables.
2. Route and stack transitions should be symmetric on enter and exit.
3. Interactive icons inside shared controls inherit the active foreground of
   their host surface.
4. If a background becomes blue, dark, or accent-heavy, foreground and icons
   must stay legible at the component layer.

## Forms And Copy

1. Focused auth, mandate, and verification flows default to flat top-anchored
   composition, not decorative logo blocks or floating wrappers.
2. Use one radius scale within a compact production flow.
3. Prefer canonical form primitives over route-local primitive restyling.
4. Mixed inputs and selects must share one row-shell geometry contract.
5. Consumer auth, onboarding, and verification copy should avoid provider names,
   backend systems, token formats, and protocol terms.
6. Keep supporting copy to one short line that directly helps the next action.

## One/Kai/Nav Copy

1. One owns shell, greetings, memory framing, background-task notifications, and
   specialist handoffs.
2. Kai owns finance analysis, portfolio, market, RIA finance, and decision
   receipt copy.
3. Nav owns consent, privacy, vault, deletion, revocation, suspicious access,
   and scope-review copy.
4. Ordinary navigation action ids use `route.*`; reserve `nav.*` for real
   Nav-owned guardian behavior.
