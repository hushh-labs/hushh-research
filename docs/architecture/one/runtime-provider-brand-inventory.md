# Runtime provider brand inventory

## Visual Context

This compact inventory sits below the [Hussh One Index](./README.md) and beside
the [Gemini Runtime Configuration](./gemini-runtime-configuration.md) contract.
It records only the fixed, transparent marks displayed in One's AI access setup
lane; it is not a provider-routing or credential surface.

This is the presentation-only source record for the AI access setup lane. A
provider mark communicates a choice that is available today or shown as
upcoming; it never
selects a model, grants runtime access, or implies a partnership.

| Model shown in One | Local asset | Source record |
| --- | --- | --- |
| Gemini | `components/brand/gemini-logo.tsx` | Existing four-point Gemini mark. |
| OpenAI | `public/brand/providers/openai.svg` | [OpenAI’s 2025 Blossom](https://openai.com/brand/) supplied as the current OpenAI logo. |
| Claude | `public/brand/providers/claude.svg` | [Claude’s current symbol](https://www.anthropic.com/), published by Anthropic for Claude. |
| Grok | `public/brand/providers/grok.svg` | [Grok’s current logo](https://grok.com/), published by X.AI. |
| Meta Muse Spark | `public/brand/providers/meta.svg` | [Meta’s company brand mark](https://about.meta.com/brand/resources/meta/company-brand/). |

## Handling rules

1. Keep the geometry unmodified and retain the source aspect ratio.
2. Use a fixed transparent mark cell. Do not place provider artwork in a
   colored tile, add a shadow, or use it as the app’s accent.
3. Black-only source marks may be inverted in dark mode for legibility; this
   does not alter the stored asset.
4. Gemini is the only selectable provider until another runtime contract,
   credential flow, and consent boundary are implemented. The remaining marks
   are labeled `Coming soon` and have no action identifiers.
5. Update this record before replacing an asset or enabling a provider.
