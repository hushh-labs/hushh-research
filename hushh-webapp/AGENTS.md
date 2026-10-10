<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Back and Search before UI edits

Read [the UI contract contributor scaffold](../docs/reference/architecture/ui-contract-contributor-guide.md) before changing routes, screens, layouts or imported UI. Run `npm run ui:doctor` first; update authored Back cases and Search actions, then `npm run build:ui-contracts` and `npm run verify:ui-contracts`. Generation runs Back before Search; a passing fingerprint is not behavioral proof.
