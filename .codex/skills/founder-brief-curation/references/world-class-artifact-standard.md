# World-Class Artifact Standard

The gold standard for a **founder-facing / organisation-facing HTML artifact** (a published
claude.ai Artifact or an equivalent self-contained page). This is distinct from a plain
Markdown→PDF report (that lane is `pdf-artifact-generation.md`). Use this when the deliverable
must be genuinely awe-inspiring — an editorial, information-dense, dual-audience document — not
a competent report. Founder bar, verbatim: *"blow my mind, nothing less than awestruck."*

## Non-negotiables

1. **Brand is real, not approximated.** The mark reads **hussh** — `hu` in ink,
   `ssh` in the accent hero-gradient (`--app-accent-hero-from/mid/to`), SF Pro Display 700,
   `letter-spacing:-5.6`, no dot separator, no stylisation. In PROSE the brand is **Hussh**
   (double-s); code/config identifiers stay their literal casing (`hushh-one`, `hushh-tenancy`,
   `HUSHH_*`, `hushh_mcp`, `a2a.hushh.ai`). See `docs/reference/operations/brand-and-compatibility-contract.md`.
2. **Tokens from the single source.** All colour comes from `hushh-webapp/app/globals.css`
   (see the palette block in `brief-curation-rules.md`). Default accent iOS Blue `#007aff`;
   Molten Gold `#d4a574` is a variant. Ship all **four themes** (light/dark × blue/gold) with a
   live in-page toggle when the user asks to see a variant; default dark + blue.
3. **Every claim verified against the running system.** No unverified number reaches the
   organisation. Gather facts from the repo (file:line evidence) before writing them; metrics
   are hard numbers with units, sourced.
4. **Dual-audience.** Every technical section carries an "In plain terms" glossary — one
   sentence per term, no jargon — so HR/general readers get the high level while engineers get
   the depth.
5. **Self-contained (CSP).** Only Google Fonts may load externally; inline all CSS/JS; SVG/
   Canvas inline; no CDN scripts, no external images. Theme-aware. No horizontal body scroll;
   wide figures scroll inside their own container. Respect `prefers-reduced-motion` as a designed
   state, not a kill switch.
6. **Professional.** No design/theme meta-commentary in the document itself (do not name the
   typefaces or "the room goes dark" in a colophon). It is a document, not a design showcase.

## The system ("The Lit Room" — the proven direction)

- **Type trio:** Fraunces (display, variable `opsz/wght/SOFT/WONK`, kept light 340–460, never
  bold; one hero word italic + gradient-clipped), Hanken Grotesk (body — premium where Inter
  reads default), IBM Plex Mono (the machine/audit voice: kickers, folios, labels, every datum).
  Tabular lining numerals everywhere. Drop cap on the opening.
- **Atmosphere:** brand-biased neutrals (HSL locked ~hue 215; never `#fff/#000/#808080`). The
  accent gradient appears in only ~4 disciplined places (top rule, wordmark/one hero word,
  one light pool, one diagram stroke) — never a full-bleed accent hero (the #1 AI tell). Grain
  via inline `feTurbulence` data-uri (opacity ~.045 light / ~.085 dark, `mix-blend:overlay`),
  a fixed vignette, an aurora light pool. ONE full-saturation accent element per viewport.
- **Structure:** a jump-nav **index** after the hero ("what this covers" + direct-scroll to
  every `id`); numbered movements with mono running heads and hairline rules; alternating dark
  "room" and light "ledger paper" bands.
- **Data visualisation (inline SVG, Tufte-minimal, colour = meaning only):** make each chart an
  argument, not decoration — e.g. dot-density belonging, a cost slopegraph + hero numeral, a
  waffle asymmetry drawn to scale, a Sankey with a single coral revoke path, a self-drawing
  journey line. Direct-label; no gridline fields.
- **A molten-gold KPI "instrument panel":** the metrics as a distinct premium spec-sheet band
  (gold-toned regardless of the page accent), hero numerals in the gold gradient + a dense grid.
- **Money/technical claims are unambiguous.** State the cost model in full (what is fixed vs
  metered, what is included, who bills) — the depth an intelligence company shows. No open
  questions like "is that per request?".
- **Motion budget 90/10:** one orchestrated scroll set-piece; everything else one-shot reveals
  fired once. Only `transform`/`opacity`; nothing loops.

## Procedure

1. **Load context:** the `artifact-design` skill (calibrate treatment), the brand contract,
   `brief-curation-rules.md` (palette), and this file. For a diagram-heavy artifact also
   `architecture-diagram-standard.md`.
2. **Verify the facts** (repo evidence) before writing any number or claim.
3. **Build** the self-contained HTML with the system above.
4. **Verify the rendered artifact headless** (Playwright): screenshot desktop AND mobile, ALL
   themes you shipped, and any orchestrated end-state; confirm zero horizontal overflow and no
   console errors; inspect every diagram for overlap/clipping. Fix, then publish.
5. **Publish** to the user's existing artifact URL (pass `url`) so their link stays stable, on
   the latest contract when the user wants latest.

## Pitfalls (the AI-made tells to avoid)

Full-bleed accent hero; Inter/Space-Grotesk everywhere; centered hero stack; non-tabular
figures; visible grain; looping motion; decorative colour; a warm-cream `#F4F1EA` + serif +
terracotta palette; theme meta-commentary in the document; approximated (hand-guessed) brand
tokens instead of the globals.css values.
