# Docs Governance


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose

Define one durable documentation model across:

- `docs/` (cross-cutting)
- `consent-protocol/docs/` (backend)
- `hushh-webapp/docs/` (frontend/native)

## Naming Rules

1. Index files must be named `README.md`.
2. Non-index docs must use `kebab-case.md`.
3. Avoid temporary plan docs in `docs/reference/`.
4. Keep paths stable; if moved, update all inbound links in the same PR.
5. Every major `docs/reference/*` domain and every declared source-tree north-star domain must have a `README.md` index.

## Placement Rules

1. Put implementation-specific backend docs in `consent-protocol/docs/`.
2. Put frontend/native implementation docs in `hushh-webapp/docs/`.
3. Keep cross-cutting architecture/ops/policy docs in root `docs/`.
4. Do not duplicate source-of-truth content across homes; link instead.
5. Put AI strategy/runtime planning in `docs/reference/ai/` unless it is backend- or frontend-only.

## Visual Coverage Rules

1. Maintained docs must expose visual coverage near the top of the page.
2. Use `## Visual Map` for docs that own a system, subsystem, flow, or contract.
3. Use `## Visual Context` for narrower docs that inherit their mental model from a canonical parent map.
4. Tier A visual owners are:
   - major README/index docs under `docs/`, `consent-protocol/docs/`, and `hushh-webapp/docs/`
   - `docs/project_context_map.md`
   - canonical architecture, IAM, Kai, mobile, CI, and branch-governance north-star docs
5. Tier B docs may link to the nearest Tier A owner instead of embedding a local diagram.
6. Diagrams must stay markdown-native. Prefer Mermaid for larger flows and ASCII only when the smaller inline sketch reads better.
7. Do not add diagrams for transient incident history, one-time maintenance activity, or branch-only cleanup.

## Root Entrypoint Rules

Root docs are not full source-of-truth specs, but they must retain a minimum useful surface.

Required baseline:

1. `README.md` must keep repo orientation value:
   - short product/system explainer
   - current stack or runtime overview
   - quick-start bootstrap
   - docs/community entry links
2. `getting_started.md` must keep one-screen bootstrap value:
   - what the developer is bootstrapping
   - minimal first-run commands
   - clear redirect to the canonical setup guide
3. `TESTING.md` must keep:
   - core testing principles
   - current command surface
   - where tests broadly live
4. `contributing.md` must keep:
   - engineering invariants
   - local contributor bootstrap
   - PR/change expectations
5. Public docs must teach the npm-first contributor surface, not maintainer-only compatibility paths.
6. Public docs must use Hushh branding unless a compatibility identifier is being referenced explicitly.
7. Secure / Scoped / Handled-by-the-user framing is allowed when it clarifies trust boundaries, but it should remain explanatory and must not replace the Hushh product name.

Allowed in root docs:

1. timeless orientation
2. presentation/community links
3. concise contributor guidance

Not allowed in root docs:

1. stale runtime specifics that duplicate canonical docs
2. outdated route/env/test inventory
3. deleted path references kept for historical convenience

## Required Quality Gates

1. `npm run verify:docs` (runtime/doc parity gate)
2. `node scripts/verify-doc-links.cjs` (broken link + dead path gate)

Both gates must pass in CI before merge.

CI gate policy:

1. Keep a minimal blocking set (secret scan, web, protocol, integration).
2. Treat docs parity and subtree drift as advisory unless explicitly promoted.
3. Do not add a new CI/parity script unless it replaces or consolidates an existing script in the same PR.
4. Every new CI/helper script must declare owner team (`frontend`, `backend`, or `platform`) and get owner approval.

## One-Time Rules

1. If a route/component/API is deleted, remove doc references in the same change.
2. If a public contract changes, update both docs and contract verification artifacts.
3. If a file is renamed, update all links immediately; no deferred follow-up.
4. Any future-plan document must include an explicit `Status` section and a promotion rule before it can be treated as implementation reference.
5. If a maintained doc loses or moves its canonical visual owner, update the linked `Visual Context` pages in the same change.

## Ownership

1. Product + platform docs in `docs/`: repository maintainers.
2. Backend docs in `consent-protocol/docs/`: backend owners.
3. Frontend/native docs in `hushh-webapp/docs/`: frontend/native owners.
