# One activity artwork

The chat header and One Feed/Profile sheet receive the same presentation state
from `AgentChatWorkspace`. This observes current work; it does not classify
message text or change agent decisions.

| Activity | State | HD fallback | Animation in header and profile |
| --- | --- | --- | --- |
| One generating a draft | `working` | `drafting-hd.png` | `working.riv` |
| One preparing an answer or running a local action | `thinking` | `thinking-hd.png` | `thinking.riv` |
| Response tokens arriving or voice speaking | `answering` | `thinking-hd.png` (shared static fallback) | `answering.riv` |
| No foreground work | `connected` | Original `profile-hd.png` | `connected.riv` |

An open editor, completed draft, queued proposal or pending confirmation is
not drafting. Draft activity comes from `EmailDraftCard`'s actual generation
request and clears on completion, failure and unmount. Answering starts only
on the current turn's first nonempty response delta, or voice playback. Loading,
provisional progress messages and a restored partial answer remain thinking.
New and reattached turns reset the output marker. Background memory persistence
does not keep the artwork busy.

All four native Rive Solo timelines preserve the authored 24 FPS, 72-frame
loops. The header and open Feed/Profile panel share one activity state. The
outgoing animation remains mounted while its replacement loads and paints,
then both crossfade using the shared opacity motion token. Additive blending
inside an isolated avatar prevents transparent artwork from dimming mid-fade.
Superseded loads and transitions cannot change the current request.

Rive loads only for visible, active surfaces without reduced motion. Animation
pauses offscreen, when the document is hidden or the native app is inactive.
These small image-backed loops use Rive's `AlwaysDraw` mode to repaint every
active frame. The runtime owns the render loop; visibility and lifecycle
pauses still stop it entirely. The earlier hosted playback failure's exact
cause remains unconfirmed.
Backing buffers are capped at the embedded images' 128px resolution while CSS
geometry remains 44/72px in the header and 192px in the panel. This avoids
20.25 times the backing-pixel count of a 576px Retina profile buffer without
adding detail; this is not a measured CPU improvement. Actual buffer dimensions
are rechecked on resize and resume, including
Rive's internal hidden-to-visible resize. HD fallback density is unchanged.
HD portraits remain the loading/error and reduced-motion fallback; answering
currently shares the thinking HD portrait for that static fallback only.
WASM is self-hosted as `rive.wasm`, matching `@rive-app/canvas` 2.44.2 (MIT).
Runtime CDN fallback and asset CDN loading are disabled. Instances, pending
render callbacks, observers and transition timers are cleaned up on replacement
or unmount. No React state updates occur per animation frame.

`rive-manifest.json` records deployed binary sizes and SHA-256 hashes.
`rive-validation.json` records exact comparison of every native rendered frame
against its 128px PNG reference, plus default state-machine looping checks.
Browser playback and lifecycle regressions are verified separately; physical
native frame pacing remains unverified.

Animated frames have a 128px source and are displayed at 192 CSS px in the panel,
so animated work artwork is softer than the HD fallback portraits.
The artwork, canvas and owning avatar surfaces have no opaque background disk.
The compact header artwork fills its existing 44px phone and 72px desktop
trigger; the panel uses a 192px surface. Canvas and fallback portraits share
the same bounds, including when playback pauses or reduced motion is enabled.

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
