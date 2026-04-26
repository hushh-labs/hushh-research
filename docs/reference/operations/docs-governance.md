# Docs Governance


## Visual Context

Canonical visual owner: [Documentation Architecture Map](./documentation-architecture-map.md). Use that map for documentation-home placement and consolidation decisions; this page is the narrower governance contract beneath it.

## Purpose

Define one durable documentation model across:

- root markdown entrypoints
- `docs/` (cross-cutting)
- `docs/future/` (future roadmap and R&D planning)
- `consent-protocol/docs/` (backend)
- `hushh-webapp/docs/` (frontend/native)

This governance contract also owns the repo-wide dual-label terminology rule:

- founder language leads when a doc is explaining platform meaning, trust boundaries, or system architecture
- implementation language stays primary where a reader must copy exact paths, package names, tokens, env vars, methods, or field names
- the canonical mapping lives in [../architecture/founder-language-matrix.md](../architecture/founder-language-matrix.md)
- the public naming and compatibility rule lives in [brand-and-compatibility-contract.md](./brand-and-compatibility-contract.md)
- the non-breaking rebrand bucket model lives in [hussh-rebrand-classification.md](./hussh-rebrand-classification.md)

## Naming Rules

1. Index files must be named `README.md`.
2. Non-index docs must use `kebab-case.md`.
3. Avoid temporary plan docs in `docs/reference/`.
4. Keep paths stable; if moved, update all inbound links in the same PR.
5. Every major `docs/reference/*` domain and every declared source-tree north-star domain must have a `README.md` index.

## Terminology Rules

1. Use founder terms such as `PCHP`, `Capability Tokens`, `Cryptographic Primitives`, `Separation of Duties`, and `Tamper-Evident History` when the page is establishing architecture meaning.
2. Immediately map those terms back to current implementation labels when operational precision matters.
3. Do not rename current endpoints, packages, token types, or code symbols in docs prose.
4. Do not describe future-state Kai/Nav separation, Merkle sealing, threshold signing, or other unshipped controls as implemented truth.
5. When a doc introduces a new architecture-heavy term, reconcile it against the founder-language matrix in the same PR.
6. Treat Hussh / One / Kai / Nav as a role contract, not interchangeable voice labels:
   - Hussh is platform, trust model, and infrastructure.
   - One is the personal agent and relationship layer.
   - Kai is the finance specialist.
   - Nav is the privacy, consent, vault, deletion, and scope-review guardian.
7. Founder draft phrases must be normalized through [../architecture/founder-language-matrix.md](../architecture/founder-language-matrix.md) before becoming canonical docs. Do not preserve stale wording such as `Hussh is your personal MCP server and AI agent`, `One has two faces`, or `Kai is the One who remembers`.
8. `hu_ssh` and `SSH for humans` are secondary founder metaphors. The canonical expansion remains `Human Secure Socket Host`.
9. Strong claims about on-device memory, no platform-controlled recovery, BYO model execution, portable One memory, or user-private action receipts require implementation references before they can leave `docs/future/`.

## Placement Rules

1. Put implementation-specific backend docs in `consent-protocol/docs/`.
2. Put frontend/native implementation docs in `hushh-webapp/docs/`.
3. Keep cross-cutting architecture/ops/policy docs in root `docs/`.
4. Do not duplicate source-of-truth content across homes; link instead.
5. Put planning-only future-state concepts and R&D assessments in `docs/future/`.
6. Put execution-owned AI strategy/runtime contracts in `docs/reference/ai/` unless they are backend- or frontend-only.
7. Keep root markdowns thin and contributor-facing; do not let them become detailed setup or architecture specs.
8. Keep `consent-protocol/docs/README.md` and `hushh-webapp/docs/README.md` as package docs indexes, not second package READMEs.

## Visual Coverage Rules

1. Maintained docs must expose visual coverage near the top of the page.
2. Use `## Visual Map` for docs that own a system, subsystem, flow, or contract.
3. Use `## Visual Context` for narrower docs that inherit their mental model from a canonical parent map.
4. Tier A visual owners are:
   - major README/index docs under `docs/`, `consent-protocol/docs/`, and `hushh-webapp/docs/`
   - `docs/project_context_map.md`
   - `docs/reference/operations/documentation-architecture-map.md`
   - `docs/reference/architecture/architecture.md`
   - `docs/reference/architecture/README.md`
   - `docs/reference/iam/README.md`
   - `docs/reference/kai/README.md`
   - `docs/reference/mobile/README.md`
   - `docs/reference/operations/README.md`
   - canonical architecture, IAM, Kai, mobile, CI, and branch-governance north-star docs
5. Tier B docs may link to the nearest Tier A owner instead of embedding a local diagram.
6. Diagrams must stay markdown-native. Prefer Mermaid for larger flows and ASCII only when the smaller inline sketch reads better.
7. Do not add diagrams for transient incident history, one-time maintenance activity, or branch-only cleanup.

## Diagram Quality Rules

1. Treat diagrams as part of the contract, not decoration.
2. Captions belong outside the figure geometry.
3. Sibling lanes or columns should use equal widths when the concept is meant to be parallel.
4. Avoid text overflow, clipped arrows, and top-heavy layouts.
5. Shared HTML/PDF artifacts require rendered-page verification, not only source inspection.

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
5. Public docs must teach the canonical contributor command surface (`bin/hushh` at repo root, package-local commands only in package-local docs), not maintainer-only compatibility paths.
6. Public docs must use Hussh branding unless a compatibility identifier is being referenced explicitly.
7. Secure / Scoped / Handled-by-the-user framing is allowed when it clarifies trust boundaries, but it should remain explanatory and must not replace the Hussh product name.

Allowed in root docs:

1. timeless orientation
2. presentation/community links
3. concise contributor guidance

Not allowed in root docs:

1. stale runtime specifics that duplicate canonical docs
2. outdated route/env/test inventory
3. deleted path references kept for historical convenience
4. package-local implementation detail that belongs in `consent-protocol/docs/` or `hushh-webapp/docs/`

## Consolidation Rules

Every maintained doc should be classified as one of:

1. `canonical`
2. `pointer/index`
3. `merge into existing canonical doc`
4. `delete`

Default bias:

1. hard-delete stale or redundant docs once a canonical replacement exists
2. merge duplicate setup/testing/reference content into the canonical doc
3. downgrade navigation-only docs into short indexes or pointers
4. keep package-local docs package-local instead of moving them into root `docs/`

## Required Quality Gates

1. `npm run verify:docs` (runtime/doc parity gate)
2. `node scripts/verify-doc-links.cjs` (broken link + dead path gate)
3. `node scripts/verify-doc-governance.cjs` (doc-home, index, thin-root, and Tier A diagram gate)
4. `node scripts/verify-doc-brand.cjs` (public-brand vs compatibility-surface gate)
5. `node scripts/verify-shareable-links.cjs` (shareable artifact link-hygiene gate)

All applicable docs gates must pass in CI before merge.

CI gate policy:

1. Keep a minimal blocking set (secret scan, web, protocol, integration).
2. Treat docs parity and subtree drift as advisory unless explicitly promoted.
3. Do not add a new CI/parity script unless it replaces or consolidates an existing script in the same PR.
4. Every new CI/helper script must declare owner team (`frontend`, `backend`, or `platform`) and get owner approval.

Terminology review gate:

1. Sweep changed docs for founder terms and implementation terms with `rg`.
2. Confirm the page still contains exact runtime labels where the reader must act on them.

Brand review gate:

1. Sweep changed docs, skills, and workflows for stray standalone `Hushh` branding.
2. Keep exact runtime identifiers unchanged when they are quoted as compatibility surfaces.
3. If a shareable artifact is added or edited, verify it does not contain local filesystem links.

## One-Time Rules

1. If a route/component/API is deleted, remove doc references in the same change.
2. If a public contract changes, update both docs and contract verification artifacts.
3. If a file is renamed, update all links immediately; no deferred follow-up.
4. Any future-plan document must include an explicit `Status` section and a promotion rule before it can be treated as implementation reference.
5. If a maintained doc loses or moves its canonical visual owner, update the linked `Visual Context` pages in the same change.
6. If documentation placement changes, update the documentation skill and the documentation architecture map in the same change.

## Ownership

1. Product + platform docs in `docs/`: repository maintainers.
2. Backend docs in `consent-protocol/docs/`: backend owners.
3. Frontend/native docs in `hushh-webapp/docs/`: frontend/native owners.
