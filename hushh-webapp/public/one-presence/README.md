# One activity artwork

The chat header and One Feed/Profile sheet receive the same presentation state
from `AgentChatWorkspace`. This observes current work; it does not classify
message text or change agent decisions.

| Activity | State | Static fallback | Animation in header and profile |
| --- | --- | --- | --- |
| Foreground tool/task execution, email draft generation or written response output | `working` | `drafting-hd.png` | `hd/working.riv` |
| One waiting for a response | `thinking` | `thinking-hd.png` | `hd/thinking.riv` |
| Voice speaking | `answering` | `answering-hd.png` | `hd/answering.riv` |
| No foreground work | `connected` | Original `profile-hd.png` | `hd/connected.riv` |

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

The active `hd/*.riv` exports run at 24 FPS over 72 frames. Working uses 16
authored typing poses with visible hand lifts, keyboard taps, a small head nod,
and one blink per three-second loop. Two-frame exposures give the hand gestures
a 12 FPS cadence. The other three activities retain their restrained portrait
lift/tilt loops. The 128px compatibility Working export uses the same sequence.
The header and open Feed/Profile panel share one activity state. The
outgoing artwork remains mounted until the requested activity has either a
decoded portrait or a painted native frame, then both crossfade using the
shared opacity motion token. A ready portrait presents a short-lived activity
while its larger Rive file is still loading; the native canvas takes over only
after its first frame paints. Async portraits wait for `decode()`, including
cached images, because a loaded image can still draw empty pixels in WebKit.
If both are unavailable, the outgoing artwork stays visible. Additive blending
inside an isolated avatar prevents transparent artwork from dimming mid-fade;
settled artwork uses normal compositing because no visible layers overlap.
Superseded loads and transitions cannot change the current request.

Rive loads only for visible, active surfaces without reduced motion. Animation
pauses offscreen, when the document is hidden or the native app is inactive.
These image-backed loops use Rive's default changed-frame drawing. Working
embeds sixteen registered 314px textures; the other scenes embed one 1254px
portrait each. The runtime owns the timeline and
render loop; visibility and lifecycle pauses still stop it entirely.
Playback and resizing wait for Rive's post-load paused-state initialization.
The public `play` method owns rendering startup; a separate early render can
consume the first pose's invalidation before the state machine is ready.
Only the SDK resizes the bitmap, so resizing also invalidates its next draw.
The Connections browser pack runs native presence cases separately on one
worker so unrelated fixture builds cannot starve native playback. All cases remain included in
the native CI shard partition with unchanged motion and first-paint deadlines.
Backing buffers follow device pixel ratio, capped at 768px per axis. This
covers the 224px panel at DPR3 (672px), and optional 256px presentations at
DPR3. Working's authored source cells provide about 314px of detail; increasing
the canvas does not add source detail. Other source textures remain 1254px.
The 128-unit logical artboard does not downsample them. Header geometry is 52–64px on phones and 104px on larger
screens. The narrow-phone minimum preserves the adjacent 44px controls.
The panel grows from 208px on the narrowest phones to 224px, bounded by its
available width. Actual buffer dimensions are rechecked on resize and resume,
including Rive's internal hidden-to-visible resize. Each native loop and its
loading/reduced-motion portrait retain the same identity. Working retains its
1254px still for reduced motion and loading.
All four activities therefore remain visually distinct during loading,
errors and reduced motion.
WASM is self-hosted as `rive.wasm`, matching `@rive-app/canvas` 2.44.2 (MIT).
Runtime CDN fallback and asset CDN loading are disabled. Instances, pending
render callbacks, observers and transition timers are cleaned up on replacement
or unmount. No React state updates occur per animation frame.

`hd/manifest.json` records active binary/source hashes, source dimensions,
texture counts and motion parameters. Rebuild with
`node scripts/design/build-one-presence-hd.mjs`; `--check` verifies exact
reproducibility and runs through `npm run verify:brand-assets`.
The legacy `rive-manifest.json` and `rive-validation.json` describe the 128px
compatibility exports; the Working entry records the updated typing frames.
`hd/working-validation.json` verifies all 72 active rendered frames and 146
state-machine frames across two loop boundaries. Its premultiplied RGBA
comparison allows one 8-bit level for float32 scaling from 314px to 128 units;
the legacy 128px comparison remains exact.
Browser playback and lifecycle regressions are verified separately; physical
native frame pacing remains unverified.

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
updates evidence. Runtime state mapping, dwell, geometry, lifecycle and
reduced-motion behavior remain owned by the existing avatar component.

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
