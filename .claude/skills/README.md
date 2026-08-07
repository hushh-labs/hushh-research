# Design skills (the anti-slop layer)

Three third-party skill packs are installed project-scoped so every agent working in
this checkout inherits the same design judgement instead of defaulting to generic,
templated output. They are guidance layers — none of them run automatically against
product code; they load when the work is design work.

Installed with [`skills`](https://skills.sh); provenance and content hashes are pinned
in [`skills-lock.json`](../../skills-lock.json) at the repo root.

## What's installed

### `impeccable` — 1 skill, 23 commands ([impeccable.style](https://impeccable.style))

The workhorse. Invoke as `/impeccable <command>`, e.g. `polish`, `audit`, `critique`,
`distill`, `harden`, `layout`, `typeset`, `colorize`, `animate`, `adapt`.
Ships a real detector (`scripts/detect.mjs`) that scans files or a live URL for
UI anti-patterns, plus iOS/Android reference passes for the Capacitor surfaces.

It is explicitly design-system-preserving: it reads existing tokens and components
rather than overwriting them, which is what we want against `hushh-webapp`'s
Tailwind + shadcn setup.

### `emilkowalski/skills` — 9 skills, motion and polish

| Skill | Use for |
| --- | --- |
| `emil-design-eng` | General UI polish and component-design judgement |
| `animate` | Building one animation correctly (curve, duration, properties, interrupts) |
| `review-animations` | Strict review of motion in a diff — approval is earned |
| `improve-animations` | Codebase-wide motion audit → prioritized, executable plans |
| `find-animation-opportunities` | Where motion would help, and what to leave alone |
| `animation-vocabulary` | Reverse lookup: "the bouncy popover thing" → *Pop in* |
| `apple-design` | Gesture, spring, sheet, and material work — relevant to iOS/Capacitor |
| `pick-ui-library` | Choose a vetted library instead of hand-rolling one |
| `prototype` | Generate several real variants behind a visual picker |

### `Leonxlnx/taste-skill` — 13 skills, direction and aesthetics

`design-taste-frontend` is the main one (anti-slop briefs for landing/marketing
surfaces). `redesign-existing-projects` audits an existing surface before changing it.
`high-end-visual-design` and `brandkit` cover the "make it feel expensive" end.
`minimalist-ui`, `industrial-brutalist-ui`, and `stitch-design-taste` are style-specific
directions. `imagegen-frontend-web` / `imagegen-frontend-mobile` / `image-to-code`
generate design references before implementation.

## Notes

- **Three skills are explicit-invocation only.** `prototype`, `pick-ui-library`, and
  `review-animations` ship `disable-model-invocation: true`, so they don't appear in the
  auto-loaded skill list by design. Call them by name.
- **Two are redundant on Claude.** `gpt-taste` targets GPT/Codex, and
  `design-taste-frontend-v1` is superseded by `design-taste-frontend`. Both were kept for
  completeness. Remove with `npx skills remove gpt-taste design-taste-frontend-v1` if the
  skill list gets noisy.
- **Node engines.** `skills` wants Node ≥22.20 and `impeccable` ≥22.12; the default here is
  v20. The impeccable detector was verified working on v20 anyway — if a script ever
  fails on an engine check, run it under `~/.nvm/versions/node/v22.22.2/bin/node`.

## Updating

```bash
npx skills@latest update          # all three packs, respecting skills-lock.json
npx skills@latest list            # what's installed
npx skills@latest experimental_install   # restore from the lockfile on a fresh clone
```

## Not done yet

`/impeccable init` generates `PRODUCT.md` and `DESIGN.md` — the product-context files the
other commands read to stay on-brand. That was left for a human to steer: those files
encode what Hushh's surfaces are *for*, and auto-generating them is exactly the kind of
plausible-but-wrong output this layer exists to prevent.
