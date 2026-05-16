# Runtime Schematics Contract

PR governance must inspect the current repo before it judges an incoming PR. A green GitHub gate, PR title, or previously remembered rule is not enough.

## Source Order

Use sources in this order:

1. Machine-readable repo state:
   - `config/ci-governance.json`
   - `.codex/skills/*/skill.json`
   - `.codex/workflows/*/workflow.json`
   - `contracts/kai/*.json`
   - `hushh-webapp/**/*.voice-action-contract.json`
   - `consent-protocol/db/release_migration_manifest.json`
   - `consent-protocol/db/contracts/*.json`
   - `hushh-webapp/lib/navigation/app-route-layout.contract.json`
2. Executable runtime files:
   - route handlers
   - services
   - proxies
   - generated gateways
   - frontend providers, guards, and callers
3. Canonical durable docs:
   - architecture contracts
   - operation runbooks
   - quality contracts
   - current-state runtime docs
4. PR body and contributor claims.

If sources disagree, treat executable runtime and checked-in contracts as current truth, then open a docs/governance follow-up if durable docs are stale.

## Anti-Hallucination Rules

1. Do not infer current capability from PR title.
2. Do not infer route reachability from a changed component alone; inspect imports, routes, shell, and providers.
3. Do not infer voice/action authority from a new hook or component; inspect local action contracts, generated gateway, dispatcher, orchestrator, and backend intent service.
4. Do not infer PKM authority from cloud schema alone; inspect vault, local cache, manifests, and sync projection behavior.
5. Do not infer DB readiness from migration presence alone; inspect release manifest, checked schema contract, and UAT/prod verification path.
6. Do not infer merge readiness from CI alone; inspect current `reviewDecision`, exact head SHA, duplicate/parallel runtime risk, and trust-boundary ownership.

## Delegated Evidence

For high-stakes or cross-surface PRs, spawn read-only evidence lanes when the project-wide checkpoint passes:

- `reviewer` for regression and proof gaps.
- `backend_architect` for route/service/proxy/schema contracts.
- `frontend_architect` for reachability, shell, route, and design-system fit.
- `security_consent_auditor` for consent, IAM, vault, PKM, BYOK, and on-device-first boundaries.
- `voice_systems_architect` for voice/action/generated-contract surfaces.
- `repo_operator` for CI, DCO, queue, deploy, and environment parity.
- `rca_investigator` when a failure must be classified before fixing.
- `governor` when multiple evidence lanes need synthesis.

Subagents return evidence. The parent session retains branch, patch, approval, merge, deploy, and final PR authority.

## Required First Command

```bash
python3 .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py --text
```

The output is not a permanent ledger. It is a current snapshot that proves the review started from live repo schematics rather than a hardcoded memory.
