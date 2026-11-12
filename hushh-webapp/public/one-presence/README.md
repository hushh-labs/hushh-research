# One activity artwork

The chat header and One Feed/Profile sheet receive the same presentation state
from `AgentChatWorkspace`. This observes current work; it does not classify
message text or change agent decisions.

| Activity | State | Compact files | Profile files |
| --- | --- | --- | --- |
| Foreground tool/task execution, email draft generation or written response output | `working` | `compact/working.webp`, `compact/working.riv` | `drafting-hd.png`, `hd/working.riv` |
| Accepted turn preparing memory or waiting for a response | `thinking` | `compact/thinking.webp`, `compact/thinking.riv` | `thinking-hd.png`, `hd/thinking.riv` |
| Voice speaking | `answering` | `compact/answering.webp`, `compact/answering.riv` | `answering-hd.png`, `hd/answering.riv` |
| No foreground work | `connected` | `compact/connected.webp`, `compact/connected.riv` | `profile-hd.png`, `hd/connected.riv` |

An open editor, completed draft, queued proposal or pending confirmation is
not drafting. Draft activity comes from `EmailDraftCard`'s actual generation
request and clears on completion, failure and unmount. Written output starts
Working on the current turn's first nonempty response delta; voice playback uses Answering. Loading,
provisional progress messages and a restored partial answer remain thinking.
New and reattached turns reset the output marker. Background memory persistence
does not keep the artwork busy.

Working takes priority while a visible server tool, governed local action or
specialist task executes. Server tool activity is bounded by the current turn,
so a failed or finished stream cannot leave a stale working pose. Confirmation
cards and waiting for Google authorization do not themselves count as execution.

Both asset sizes use the same 24 FPS, 72-frame timeline. Working retains the
16 registered typing poses and their blink. Idle gently breathes around a
pivot near the feet, so the profile name gap stays stable. Compact uses 320px
WebP portraits and 256px typing textures. Profile preserves the 1254px portraits
and 314px typing textures. Rive's backing buffers follow device pixel ratio
up to 320px for compact and 768px for profile.

The latest state replaces any pending pose. The outgoing pixels stay visible
while the new portrait decodes or the first animation frame paints. After
150 ms the incoming pose can use its embedded still, and the active surfaces
crossfade over 180 ms. Reduced motion and inactive surfaces switch directly
to the latest still. The native canvas takes over only after its first
nontransparent frame paints, including after a resize. Async portraits wait
for decode even on a warm cache. The embedded still also covers failed posters.

Playback starts only on visible surfaces when the app is active and reduced
motion is off. It pauses offscreen or in the background. A 4.5-second deadline
covers module, WASM, file, decode and first paint for each attempt. A failed
attempt releases its runtime and retries once while playback is allowed.
WASM is shared and self-hosted as `rive.wasm`, matching
`@rive-app/canvas` 2.44.2 (MIT). CDN fallback is disabled. Painted asset bytes
are reused across turns and profile reopenings. Each surface owns its canvas
and cancels obsolete loads, frames and timers on replacement or unmount.

The `hd/manifest.json` and `compact/manifest.json` files record the active asset
hashes, source dimensions and motion parameters. The builder also emits the
embedded stills. Rebuild with `node scripts/design/build-one-presence-hd.mjs`.
`--check` verifies reproducibility and runs through `npm run verify:brand-assets`.

The legacy `rive-manifest.json` and `rive-validation.json` describe the 128px
compatibility exports. `hd/working-validation.json` verifies all 72 active
rendered frames and 146 state-machine frames across two loop boundaries.
Its premultiplied RGBA comparison allows one 8-bit level for float32 scaling
from 314px to 128 units. The legacy comparison remains exact.

## Rebuilding the typing frames

The transparent 4x4 source sheet and full generation prompt live at
`assets/one-presence/working-keyframes.png` and `working-keyframes.md`.
The exporter applies one union crop and one scale to all poses, preserving
registration, and records the exact sequence in `working-animation.json`.
The existing HD builder owns its manifest and composes the typing exporter:

```sh
node scripts/design/build-one-presence-hd.mjs
node scripts/design/build-one-presence-hd.mjs --check
node scripts/design/verify-one-working-presence.mjs --write
node scripts/design/verify-one-working-presence.mjs --hd --write
```

The verifiers use the real self-hosted WASM renderer in installed Playwright
Chromium. Omit `--write` for read-only verification. A failed assertion never
updates evidence. Runtime state mapping, geometry, lifecycle and reduced-motion behavior remain owned by the existing avatar component.

The artwork, canvas and owning avatar surfaces have no opaque background disk.
The compact header artwork fills its responsive trigger. The name occupies
the common transparent lower inset, keeping it immediately beneath the
mascot without covering its feet or moving when a native loop replaces a
portrait. This artwork-only control has no Material ripple, hover fill, press
fill or tap flash; keyboard focus uses a thin outline without a filled halo.
The panel uses a responsive square 208–224px surface by default, bounded by its available
width; `--one-presence-size` can resize that owning container without changing
the native instance. Canvas and fallback portraits share
the same bounds, including when playback pauses or reduced motion is enabled.

## Current Rive input boundary

Runtime inspection of all four deployed files reports
`stateMachineNames: ["State Machine 1"]` and
`stateMachineInputs("State Machine 1"): []`. Each file contains one activity
artboard and no boolean, number or trigger inputs. These exports cannot drive
hover/tap behavior or four activities through one persistent input-driven
instance. That requires an authored combined asset with explicit inputs;
changing the React adapter or reloading the canvas does not supply them.
The existing activity mapping and painted crossfades remain the compatibility
path until such an asset is available.

## HD variant provenance

The 1254px transparent `thinking-hd.png` and `drafting-hd.png` were made with the
built-in `image_gen` tool, using `profile-hd.png` as the identity reference and
the corresponding existing sprite sheet as a pose reference. The idle artwork
was preserved unchanged.

Shared prompt: preserve the same glossy gold full-body mascot, oval dark eyes,
material, lighting, camera and proportions. Produce one centered square cutout
with transparent alpha, head near 16% and feet near 89% of the canvas; retain
padding and crisp Retina detail. No grid, sprite-sheet artifacts, ground plane,
text, background or extra characters.

- Thinking variant: one hand under the chin with a thoughtful expression; other
  arm relaxed. No shushing finger, headphones or laptop.
- Drafting variant: charcoal over-ear headphones and a small dark laptop at
  waist height, actively typing; full body and both feet visible. No shushing
  finger or additional props.
- Answering variant: generated with built-in `image_gen`, using `profile-hd.png`
  as identity and `answering-poster.png` as pose references. Preserve the same
  glossy gold full-body mascot, proportions, lighting and camera; one hand
  presents palm up and the other holds a small blank ivory note card. One
  centered 1254px transparent cutout, with both feet visible; no headphones,
  laptop, text, background or extra characters.
