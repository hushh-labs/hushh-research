---
name: morphy-pdf
description: >
  Morphy AX/UX — the Hushh brand design system for polished PDF/HTML documents
  (partner specs, architecture briefs, agent-experience docs). A modular theme
  abstraction: one design language with light and dark variants plus a per-application
  accent hook, so every document reads as one system while allowing creative variation.
  Use when producing a branded PDF/document for Hushh, or when the user asks for the
  "Morphy" look, a themed spec/brief, or a dark/light variant of a document.
---

# Morphy AX/UX — modular brand theme for documents

Morphy is Hushh's document design language: soft, layered surfaces; gently rounded
cards with subtle elevation; a **Manrope** (geometric headers) + **Inter** (body)
pairing; and an Anypoint/MuleSoft-aligned palette. It is built to be **abstracted and
varied** — the brand stays constant, the creativity flexes per application.

## The three axes of variation (modular)

1. **Theme — `light` | `dark`.** The same content renders in either; tokens swap via
   `[data-theme="dark"]`. Light for print/partner PDFs; dark for screen decks or a
   bolder feel.
2. **Accent — per application.** Override `--brand-accent` / `--brand-accent-2` to give
   a document its own tint (e.g. Anypoint blue→cyan for a partner spec, teal for an
   internal-ops brief) without leaving the system. Pass `--accent` / `--accent2`.
3. **Composition — the fragment.** You write only the *content* (cover + sections) as a
   BODY fragment using the component classes below; the skill wraps it in the branded
   shell (fonts + tokens + print rules).

## How to produce a document

1. Write a **BODY fragment** (`content.html`) — no `<html>/<head>/<body>`, just the
   cover + `<section>`s — using the component classes in `assets/morphy.css`.
2. Render:
   ```bash
   python scripts/render.py content.html out.pdf --theme light \
     --title "Hushh × Anypoint — Spec" --accent "#1A6DF0" --accent2 "#00A5DF"
   # dark variant of the very same fragment:
   python scripts/render.py content.html out-dark.pdf --theme dark
   ```
   The renderer embeds the fonts (data URIs), inlines `morphy.css`, applies the theme +
   accent, and prints the PDF with headless Chromium. Output is self-contained.
3. **QA visually** before delivering: screenshot the cover + a content page (Chromium
   `--screenshot`) and check fonts, gradients, page breaks, and (for dark) contrast.

## Component vocabulary (classes in `assets/morphy.css`)

- **Cover:** `.cover` (with `.glow`, `.kicker`, `.ggrad`, `.brandrow`, `.metacard > .m`).
- **Sections:** `.sec-head` + `.sec-chip` (numbered gradient chip; `.alt` = teal) + `<h2>`.
- **Surfaces:** `.panel` (`.blue|.teal|.amber` tints), `.card`, `.grid2`.
- **Data:** `table.col-a`, `.pill` (`.blue|.teal|.amber`).
- **Snippets:** `<pre>` (mono code block, theme-aware) with a `.snip-cap` label.
- **Architecture:** `.diagram` > `.layer` > `.row` > `.box` (`.blue|.teal|.person`),
  `.flow` (arrows), `.legend`/`.dot`.
- Utilities: `.lead`, `.muted`, `.faint`, `.small`, `.tiny`, `.avoid` (no page break),
  `.page-break`.

## Tokens (light → dark)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--ink` | `#0F1E38` | `#EAF0FB` | headings + text |
| `--bg` / `--surface` | `#FFF` / `#FFF` | `#0B1424` / `#111E33` | page + cards |
| `--panel` / `--line` | `#EEF3FB` / `#E1E8F4` | `#10203A` / `#233149` | tints + borders |
| `--brand-accent` | `#1A6DF0` | `#4C8DFF` | primary |
| `--brand-accent-2` | `#00A5DF` | `#2FC0F5` | secondary / gradient |
| `--brand-teal` | `#12A594` | `#2BC0AC` | governance / partner-owned |
| `--brand-amber` | `#B4690E` | `#E0A24A` | "in pursuit" / caution |

## Emoji + brand rules

Customer/partner-facing copy uses only the 🤫 emoji and country flags; functional
monochrome glyphs (arrows, ✓/✕) are allowed as interface affordances. Keep copy clean
and Apple-grade (Jobs would ship it; Munger would call it honest).

## Assets + licensing

- `assets/fonts/inter-variable.woff2`, `manrope-variable.woff2` — Inter and Manrope,
  both under the SIL Open Font License 1.1 (free to embed + redistribute).
- `assets/morphy.css` — tokens + components (theme- and accent-agnostic).
- `examples/` — reference fragments (e.g. the Anypoint integration spec).
