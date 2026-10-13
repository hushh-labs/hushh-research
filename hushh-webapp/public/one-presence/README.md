# One activity artwork

The chat header and One Feed/Profile sheet receive the same presentation state
from `AgentChatWorkspace`. This observes current work; it does not classify
message text or change agent decisions.

| Activity | State | Large portrait | Compact animation |
| --- | --- | --- | --- |
| One generating a draft | `working` | `drafting-hd.png` | `working.webp` |
| One preparing or delivering an answer, or running a local action | `thinking` | `thinking-hd.png` | `thinking.webp` |
| No foreground work | `connected` | Original `profile-hd.png` | Original `profile-hd.png`, still |

An open editor, completed draft, queued proposal or pending confirmation is
not drafting. Draft activity comes from `EmailDraftCard`'s actual generation
request and clears on completion, failure and unmount. Chat activity uses live
loading/streaming and existing local-action busy flags. Stale tool rows and
background memory persistence do not keep the artwork busy.

The legacy `answering` state also displays the thinking pose. Existing work
animations remain available at 24 FPS with reduced-motion and visibility
guards. A matching HD portrait is their loading/error fallback. Large artwork
uses native images rather than magnifying the 128px animation frames.

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
