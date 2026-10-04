# Contracts Index

`contracts/` holds two kinds of file, and the rule for editing them is opposite.

**Generated artifacts** (`agents/`, `architecture/`, `kai/`) are emitted from an
authoring source. Do not hand-edit; change the source and regenerate. Each one has
a `--check` command, and `scripts/ci/repo-governance-check.sh` runs the topology
one in CI.

**Authored truth tables** (`pkm/`) are the authoring source. No generator emits
them, and hand-editing is how they are meant to change. They exist so that two
implementations of the same rule, one in TypeScript and one in Python, read from a
single file instead of drifting. Each has tests on both sides, but be aware that
none of those tests currently gates a pull request, so an edit here is only as
safe as the review it gets.

## Directory map

| Path | Contract | Authored source | Generator | Primary consumers |
| --- | --- | --- | --- | --- |
| `agents/product-agent-registry.v2.json` | Product-agent hierarchy, cards, surfaces | `AgentManifestV2` YAML manifests (consent-protocol) | `consent-protocol/scripts/generate_product_agent_registry.py` | hierarchy verification and topology maintenance; runtime dispatch remains separately declared |
| `agents/pod-specialist-capability-matrix.v1.json` | Per-manifest pod execution matrix: what each product agent may do inside an owner's pod (executes in pod, information source, write scope, confirmation owner) joined with facts parsed from the pod runtime source; `disagreements` must be empty | `AgentManifestV2` manifests plus `POD_SPECIALIST_EXECUTION` in `consent-protocol/hushh_mcp/services/pod_specialist_runtime.py` | `consent-protocol/scripts/generate_pod_specialist_capability_matrix.py` | `tests/test_pod_specialist_capability_matrix.py`, the `specialists-run-in-pod` ledger receipt, product-agent-development workflow |
| `architecture/runtime-topology-index.v1.json` | Metadata-only route, semantic workspace, agent, database-family, and compatibility index | route/cache/action/agent/database contracts plus `config/runtime-topology-maintenance.json` | `scripts/ops/generate_runtime_topology_index.py` | maintenance workflow, topology review, current-context routing |
| `kai/kai-action-gateway.vnext.json` | Full generated action gateway (213 actions across 44 surfaces as of 2026-09-11: guards, goals, execution targets) | per-page `*.voice-action-contract.json` files in `hushh-webapp/app/**` | `hushh-webapp/scripts/voice/generate-kai-action-gateway.mjs` (`npm run build:voice-gateway`) | backend `hushh_mcp/services/voice_action_manifest.py`, frontend `lib/voice/kai-action-gateway.ts` |
| `kai/one-capability-graph.v1.json` | Capability graph projection over the gateway (208 actions, 7 workflows) | the gateway above | `hushh-webapp/scripts/voice/generate-capability-graph.mjs` (`npm run build:capability-graph`) | capability projection tests, `npm run verify:capability-graph` |
| `kai/one-route-orchestration-index.v1.json` | Route -> screen/playbook/action/delegation policy index | route layouts + gateway | `hushh-webapp/scripts/voice/generate-route-orchestration-index.mjs` (`npm run build:route-orchestration-index`) | backend `hushh_mcp/services/route_orchestration_index.py` (live relay route policy), frontend route tests |

## Authored truth tables

| Path | Contract | Read by |
| --- | --- | --- |
| `pkm/internal-path-keys.v1.json` | Which stored keys are plumbing rather than a person's record, so they never become requestable | `hushh-webapp/lib/pkm/internal-path-keys.ts` and `consent-protocol/hushh_mcp/consent/internal_path_keys.py` |
| `pkm/secret-patterns.v1.json` | Which spans of text are secrets (keys, passwords, tokens, private keys, card and government id numbers), with each kind's filing target and shared positive and negative cases | `hushh-webapp/lib/pkm/secret-patterns.ts` (the device guard) and `consent-protocol/hushh_mcp/consent/secret_patterns.py` (the server's second net); byte-identical copies in `consent-protocol/contracts/pkm/` and `hushh-webapp/contracts/pkm/` |
| `pkm/reserved-branches.v1.json` | Which PKM branches an app feature owns, the closed catalogue of writers, and which writers may change each branch (shadow mode: counted, not yet refused) | `consent-protocol/hushh_mcp/consent/reserved_branches.py` and `hushh-webapp/lib/pkm/reserved-branches.ts`; byte-identical copies in `consent-protocol/contracts/pkm/` and `hushh-webapp/contracts/pkm/` |
| `pkm/segment-humanization.v1.json` | How one path segment is spelled for a person | `hushh-webapp/lib/pkm/humanize-segment.ts` and `consent-protocol/hushh_mcp/consent/segment_labels.py` |
| `consent/field-sensitivity.v1.json` | Which FIELDS are sensitive in any domain (identifier keys such as an EIN, and identifier-shaped values), so they never reach the model even inside a standard item | `consent-protocol/hushh_mcp/consent/field_sensitivity.py` and `hushh-webapp/lib/consent/field-sensitivity.ts` (the continuation builder and the secure card) |
| `consent/field-labels.v1.json` | Human names for field keys and enum values ("Fein" is "Federal EIN", "C_CORP" is "C corporation") | `consent-protocol/hushh_mcp/consent/field_labels.py` and `hushh-webapp/lib/consent/field-labels.ts` (names a field the device withholds); the secure card's own label table has not moved onto it yet |

All five are hand-edited on purpose. The two `consent/` tables are read by the
backend at runtime, so each also has an in-context copy under
`consent-protocol/contracts/consent/` that must match this one
(`consent-protocol/tests/test_generated_contract_packaging.py`), and a copy under
`hushh-webapp/contracts/consent/` that the webapp imports
(`hushh-webapp/__tests__/lib/consent/field-sensitivity-contract.test.ts`, which also runs every case). Changing either changes what the product will
offer to share, so the two implementations must be re-run together.

## Duplication rule

`hushh-webapp/contracts/kai/*` mirrors `contracts/kai/*` byte-for-byte, verified
2026-09-11 for all three files. The generators write BOTH copies in one run;
never edit either copy directly.

The mirror is a build-pipeline convenience, not a hard constraint of the
framework. `hushh-webapp/lib/pkm/internal-path-keys.ts` imports
`@/../contracts/pkm/internal-path-keys.v1.json` from outside the webapp root and
builds, so "Next.js cannot import JSON from outside its project root" is not why
the mirror exists. Treat the mirror as the established convention for generated
`kai/` artifacts; the authored `pkm/` tables are deliberately not mirrored.

Verify sync with:

```bash
cd hushh-webapp && npm run verify:voice-gateway && npm run verify:route-orchestration-index
```

## Runtime topology maintenance

The runtime topology index is a generated maintenance projection. It is never
an action router, consent authority, or source of user information. Regenerate
and verify it with:

```bash
python3 scripts/ops/generate_runtime_topology_index.py
python3 scripts/ops/generate_runtime_topology_index.py --check
```

## Naming note

The `kai/` directory name is a preserved Kai-era compatibility identifier (see
`docs/reference/operations/brand-and-compatibility-contract.md`). The runtime
these contracts drive is One Voice; renaming the directory is a coordinated
migration across the generators, backend loaders, frontend imports, and
`.codex` governance scripts, tracked separately from routine contract changes.
