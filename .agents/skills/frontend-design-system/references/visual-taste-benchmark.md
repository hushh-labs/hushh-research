# Hussh One Visual Taste Benchmark & Anti-Slop Contract

## Canonical Aesthetic Lineage

Hussh One follows one unified visual craft standard across every web and native surface:

- **Apple Private Cloud + Apple HIG:** calm matte luminance, optical alignment, progressive top-bar blur dissolution, respectful restraint, zero visual noise.
- **Linear + Vercel Geist:** crisp `1px` hairline borders (`border-black/[0.08]` / `dark:border-white/[0.09]`), tight density, calibrated control heights, right-aligned `tabular-nums` financial typography, and clean micro-contrast between surface layers.
- **Code-Owned Open-Source Primitives:** Base UI / Radix accessibility semantics, shadcn/ui code-owned variants, Origin UI / Kibo UI structured card & metric patterns, and Emil Kowalski / Impeccable anti-slop craft constraints.

## Live Visual Reference (Founder Sign-Off Surface)

Inspect and compare every UI change against the live Reference-Design Storybook at **`/design-system`** (`hushh-webapp/components/design-system/reference-storybook.tsx`):

1. **Button Density & Shape Scale (`hushh-webapp/lib/ui/button-variants.ts`):**
   - `xs`: `28px` (`h-7`, `rounded-[8px]`, `12px` medium) for dense filter toggles and micro-controls.
   - `compact` / `sm`: `32px` (`h-8`, `rounded-[9px]`, `12.5px` medium) for toolbars (`Files`: `Upload`, `Optimize memory`, `Import archive`), footer utilities (`Check for updates`), and inline card actions (`Open`).
   - `default` / `standard`: `36px` (`h-9`, `rounded-[10px]`, `13.5px` medium) for ordinary form, dialog, and sheet actions.
   - `prominent`: `40px` (`h-10`, `rounded-[11px]`, `14px` semibold) exclusively for primary flow commit CTAs.
   - `row`: `28px` (`h-7`, `rounded-full`) reserved strictly for compact inline row badges/chips; circular `icon` controls keep `rounded-full`.
   - Coarse touch devices expand tap safety through `@media (pointer: coarse)` without bloating visual button chrome on desktop or tablet.

2. **Universal Top App Bar Progressive Mask Fade (`hushh-webapp/app/globals.css`):**
   - `.ambient-chrome-mask--top` applies Agent Chat's raised-cosine progressive blur and mask dissolve (`blur(20px) saturate(180%)` fading cleanly across `--top-fade-active`) as the universal default on every signed-in and reading screen.
   - Never reintroduce a hard opaque horizontal cutoff line or a second route-local gradient overlay.

3. **Tactile Notification, Consent, and Shared-Access Cards:**
   - Lead with a framed identity anchor (person avatar with status badge or framed semantic icon tile), crisp two-line typography (`13.5px` title + inline semantic pill + `12.5px` scope/term detail), and a horizontally balanced inline `size="compact"` action.
   - Never render giant blank vertical voids with a tiny unframed icon in one corner and an orphaned button pushed into the bottom right.
   - Never default to generic robotic placeholder copy (`"Ready to open from your connections."`) when sender identity, scope label, or encryption posture is available.

4. **Financial Surfaces & Hosting Telemetry:**
   - Present financial summaries in aligned `tabular-nums` metric strips (`Net worth`, `Liquid cash`, `Investable`) and right-aligned numeric markdown tables with uppercase muted headers and subtle row dividers.
   - Present active hosting tiers as living hero cards with a breathing presence indicator, zero text truncation (`360px` mobile and `370px` desktop drawer), an integrated footer check action, and zero duplicate option under `Switch hosting`.

## Explicit Anti-Slop Rejection List (Distilled from Impeccable & Emil Kowalski)

Reject any UI diff that introduces:

1. **Bloated 44px-56px visual pills** on toolbars, utility buttons, or card actions where `32px` (`compact`) or `36px` (`standard`) belongs.
2. **Dead-void cards** where more than half the card area is empty whitespace separating a top-left label from a bottom-right button.
3. **Mismatched toolbar geometry** (mixing `48px` pills, `32px` inputs, and thick grey borders in the same horizontal toolbar row).
4. **Hardcoded local button overrides** (`min-h-10 rounded-full text-sm font-semibold`) fighting the core `<Button>` primitive.
5. **Truncated product or hosting tier titles** (`...` ellipsis on `Hussh Confidential Sandbox` or `Bring your own cloud`).
6. **Synthetic chat continuation bubbles** echoing internal harness/connector state strings as fake user messages.
7. **Inline chat flooding with raw shared records:** Decrypted shared-with-you data received in Chat must always render as a compact summary card with a `View details` trigger opening a bounded scrollable Detailed View Modal (`Dialog`), never dumping dozens of flat key-value rows directly into the transcript.
8. **Unverified layout claims:** verify every new or restyled surface at `360px` mobile and desktop in both Light and Dark themes on `/design-system` or the live route before calling it done.
