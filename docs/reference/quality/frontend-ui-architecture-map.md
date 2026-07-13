# Frontend UI Architecture Map

## Visual Context

Canonical visual owner: [Quality and Design System Index](./README.md). Use that map for the top-down quality and UI-system surface; this page is the narrower frontend architecture contract beneath it.

## Canonical Map

| Layer | Location | Purpose | Rules |
|---|---|---|---|
| Stock primitives | `hushh-webapp/components/ui/*` | Registry-backed baseline controls | Keep overwrite-safe. No app semantics here. |
| Morphy UX | `hushh-webapp/lib/morphy-ux/*` | Standalone design-system root | Own tokens, primitive surface shells, motion, and reusable interaction layers. Do not pull in feature or app-ui code. |
| Morphy AX | `hushh-webapp/lib/morphy-ax/*` | Pure redacted Agent Experience derivation | Composes authored route, chrome, and interaction-layer state. It never owns visuals, routing, actions, or a second store. |
| App surfaces | `hushh-webapp/components/app-ui/*` | Hussh shell chrome and semantic shared compositions | Own shell, settings, page chrome, and semantic wrappers built on Morphy primitives. |
| Feature composition | `hushh-webapp/components/<feature>/*`, `hushh-webapp/app/**` | Route-level composition and feature behavior | Reuse stock or app-ui primitives before inventing new surfaces. |
| Labs | `hushh-webapp/app/labs/*`, `hushh-webapp/components/labs/*`, `hushh-webapp/lib/labs/*` | Experimental visual exploration | Never import directly into production Kai routes without graduation. |

## Canonical Production Baseline

The production baseline is the current solved shell and settings language on localhost/UAT:

1. High-contrast top-shell chips and action surfaces.
2. Rounded segmented tabs with a clear active border and elevated highlight.
3. Single interaction owner per actionable row or shell surface.
4. Neutral premium surfaces built from shared tokens, not route-local chrome recipes.
5. One semantic route-container system:
   - `reading`
   - `standard`
   - `expanded`
6. One curated header accent map:
   - `neutral`
   - `kai`
   - `ria`
   - `consent`
   - `marketplace`
   - `developers`

Reference implementations:

1. `hushh-webapp/components/app-ui/top-app-bar.tsx`
2. `hushh-webapp/components/app-ui/settings-ui.tsx`
3. `docs/reference/quality/app-surface-design-system.md`

## Primitive Selection Rules

1. Default to stock `@/components/ui/*`.
2. Use Morphy when the change belongs to the reusable design-system layer:
   - tokens
   - primitive card and surface shells
   - ripple/state layer
   - motion
3. Create or extend `components/app-ui/*` when the surface is semantic and app-specific:
   - shell actions
   - page chrome
   - settings/list rows
   - shared product-level composition
4. Do not create feature-local one-off primitives when a shared semantic surface should exist.
5. Do not create route-local outer width shells when `AppPageShell` or `FullscreenFlowShell` should own the container.

## Agent-aware interaction layers

1. Dialogs, popovers, sheets, menus, and bounded option surfaces keep their visual and
   accessibility behavior in Morphy UX or app-ui composition.
2. A voice-supported surface publishes authored metadata with role `route`, `chrome`,
   or `interaction_layer`; it never relies on DOM discovery.
3. `VoiceInteractionLayerV1` is redacted behavior metadata, not a visual primitive.
4. Modal and blocking layers hide underlying actions. Nonmodal layers retain only
   explicitly permitted route controls.
5. Each dismissible layer maps its visible close/cancel control to an exact generated
   action and mounted handler. Settlement follows committed close and focus return.
6. Legal and informational layers may keep Agent Bar interactive above their scrim;
   credential, OTP, vault, and destructive layers make it ambient or suppress it.
7. Browser-owned provider popups are external attempts, not interaction layers.

## Labs Graduation Rule

A lab pattern graduates into production only after it has:

1. Accessible focus and interaction behavior.
2. Mobile-safe layout behavior.
3. Production token alignment.
4. Verification coverage.
5. A clear owner in `components/ui`, `lib/morphy-ux`, or `components/app-ui`.

## Repo-Owned Skill Entry Points

Project skills live under `.codex/skills/`:

1. `frontend`
2. `frontend-design-system`
3. `frontend-architecture`
4. `frontend-surface-placement`
5. `frontend-native-surface-mapper`
6. `frontend-cache-coherence`
7. `morphy-ax`

These skills must stay aligned with the docs and verification commands in this quality section.
