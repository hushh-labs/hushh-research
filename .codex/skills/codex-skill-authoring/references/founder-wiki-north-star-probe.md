# Founder Wiki North-Star Probe

Use this reference when a repo task needs Hussh product direction, founder language, or future-state alignment from the founder wiki MCP.

The founder wiki is an evidence lane, not a replacement for repo truth.

## Authority Order

1. Current executable code, generated contracts, schemas, tests, CI, and runtime logs define what exists today.
2. Durable repo docs define checked-in architecture and implementation intent.
3. Founder wiki product canon defines north-star direction, product language, non-negotiables, and future-state alignment.
4. PR text, issue text, chat prompts, and contributor claims are claims to verify.

When the wiki and repo disagree, classify the finding as `current_state_vs_north_star_drift`. Do not silently rewrite repo docs, block useful implementation, or promote private future-state language into public comments.

## Default Product Canon

For material product, architecture, PR governance, roadmap, or community-facing work, check the smallest relevant subset of:

1. `hussh://docs/non-negotiables`
2. `hussh://wiki/index`
3. `wiki/products/one.md`
4. `wiki/products/kai.md`
5. `wiki/products/nav.md`
6. `wiki/products/pchp.md`
7. `wiki/concepts/personal-operating-layer.md`
8. `wiki/concepts/byoa.md`
9. `wiki/concepts/world-model.md`
10. `wiki/concepts/aha-moment.md`
11. `wiki/concepts/mlx-on-one-surfaces.md`
12. `wiki/concepts/app-intents-conformance.md`
13. `wiki/concepts/llm-wiki-pattern.md`
14. `wiki/concepts/openclaw.md`
15. `wiki/concepts/hu-ssh.md`
16. `wiki/concepts/signature-vault.md`
17. `wiki/concepts/north-star-user-persona.md`
18. `wiki/concepts/one-lens.md`
19. `wiki/concepts/pchp-brand-side-endpoint.md`
20. `wiki/products/ibrokerage.md`
21. `wiki/projects/one-email-kyc-wiki-integration.md`

Use `wiki_search` for task-specific pages after reading the index.

## Product Boundaries

Use these as north-star checks, then verify repo current state separately:

1. One is the personal agent platform and personal operating layer, not a generic assistant or super-app destination.
2. Kai assembles context, proposes decisions, and executes only through consented action paths.
3. Nav is the privacy and consent guardian; helper and protector voices must stay distinct.
4. PCHP is the consent protocol and "SSH for humans"; every user-data read must preserve consent, audit, revocation, and ephemeral access boundaries.
5. BYOA/BYOK/on-device direction is an architectural constraint, not an optional marketing feature.
6. World Model and PKM proposals must preserve user-side encrypted authority; cloud projections are not canonical memory unless a checked contract says so.
7. Aha Moment work must be real, fast, and defensible; no fabricated financial numbers or vague "AI magic" claims.
8. OpenClaw-style and LLM Wiki proposals must preserve the boundary between public portable-brain patterns and Hussh's consented, user-owned PKM/runtime authority.
9. iBrokerage, Signature Vault, and One Email KYC work are product-surface signals only when they improve a reachable One/Kai/Nav/PCHP workflow through existing trust boundaries.

## Privacy And Citation Rules

1. Default to read-only wiki access.
2. Private wiki evidence stays local-only unless the user explicitly asks for an internal private draft.
3. Do not write, patch, capture, or link wiki pages unless the user explicitly asks in that task.
4. Do not mirror private wiki content into repo files or `tmp/`.
5. Local reports may mention private page names and drift classifications.
6. Public GitHub PR comments must not cite private wiki pages or reveal private wiki details.
7. Public/community replies may use public-safe founder language, but should cite public repo docs unless the user explicitly wants wiki links.
8. Secrets, tokens, OAuth client secrets, bearer tokens, and private wiki auth state must never be committed.

## PR Governance Trigger

Run this probe for material PRs that touch:

1. product direction or founder language
2. One, Kai, Nav, PCHP, BYOA, BYOK, MLX, on-device AI, or App Intents
3. consent, vault, PKM, World Model, memory, or cloud projection authority
4. user-facing workflows, voice/action, finance recommendations, KYC, signatures, or Aha Moment claims
5. new standalone roots or surfaces that claim product value but are not reachable from canonical app/backend/package paths

Do not run this probe for typo-only, lockfile-only, or purely mechanical changes unless the claim touches product direction.

## Output Shape

When the probe matters, include:

1. `founder_wiki_pages_checked`
2. `north_star_alignment`
3. `current_state_vs_north_star_drift`
4. `public_comment_policy`
5. `smallest_repo_aligned_next_step`

## Workspace Audit

Use `.codex/skills/codex-skill-authoring/scripts/founder_wiki_workspace_audit.py` when the task requires a holistic private Founder Wiki comparison against repo docs, skills, PR governance, or planning workflows.

The audit must use `HUSHH_FOUNDER_WIKI_MCP_TOKEN` from the local environment, verify authenticated private MCP mode, and write only page names plus classifications to `tmp/`. It must not write raw HCTs or private page bodies.
