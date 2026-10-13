# One activity artwork

The chat header and One Feed/Profile sheet receive the same presentation state
from `AgentChatWorkspace`. This observes current work; it does not classify
message text or change agent decisions.

| Activity | State | HD fallback | Animation in header and profile |
| --- | --- | --- | --- |
| One generating a draft | `working` | `drafting-hd.png` | `working.riv` |
| One preparing or delivering an answer, or running a local action | `thinking` | `thinking-hd.png` | `thinking.riv` |
| No foreground work | `connected` | Original `profile-hd.png` | Original `profile-hd.png`, still |

An open editor, completed draft, queued proposal or pending confirmation is
not drafting. Draft activity comes from `EmailDraftCard`'s actual generation
request and clears on completion, failure and unmount. Chat activity uses live
loading/streaming and existing local-action busy flags. Stale tool rows and
background memory persistence do not keep the artwork busy.

The legacy `answering` state also displays the thinking pose. Native Rive work
animations preserve the existing 24 FPS, 72-frame loops with reduced-motion and visibility
guards. A matching transparent HD portrait is their loading/error and reduced-motion
fallback. Both the header and open Feed/Profile panel use the existing work
frames, preserving the shared activity mapping. Animation pauses when offscreen,
when the document is hidden, or when the app lifecycle is inactive/background.
No React state updates occur per frame. Idle keeps the sharp native HD image.

Rive uses native Solo switching between embedded lossless PNG frames. Only the
current visible state loads, and WASM is self-hosted as `rive.wasm`, matching
`@rive-app/canvas` 2.44.2 (MIT). Runtime CDN fallback and asset CDN loading are
explicitly disabled; load failures retain the HD portrait. Instances and
observers are cleaned up on state changes and unmount. Connected and Answering
Rive exports are included as additional authored assets; existing idle and
legacy-answering presentation policy stays unchanged.

`rive-manifest.json` records deployed binary sizes and SHA-256 hashes.
`rive-validation.json` records exact comparison of every native rendered frame
against its 128px PNG reference, plus default state-machine looping checks.
Browser playback and lifecycle regressions are verified separately; physical
native frame pacing remains unverified.

Active frames have a 128px source and are displayed at 192 CSS px in the panel,
so animated work artwork is softer than the HD idle/reduced-motion portraits.
The artwork, canvas and owning avatar surfaces have no opaque background disk.

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
