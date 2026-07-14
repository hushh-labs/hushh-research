# Generated Contracts Index

Every file under `contracts/` is GENERATED. Do not hand-edit; change the
authoring source and regenerate. CI verifies each artifact with the matching
`--check` command.

## Directory map

| Path | Contract | Authored source | Generator | Primary consumers |
| --- | --- | --- | --- | --- |
| `agents/product-agent-registry.v2.json` | Product-agent hierarchy, cards, surfaces | `AgentManifestV2` YAML manifests (consent-protocol) | `consent-protocol/scripts/generate_product_agent_registry.py` | agent hierarchy verification, A2A dispatch registry |
| `kai/kai-action-gateway.vnext.json` | Full generated action gateway (~94 actions: guards, goals, execution targets) | per-page `*.voice-action-contract.json` files in `hushh-webapp/app/**` | `hushh-webapp/scripts/voice/generate-kai-action-gateway.mjs` (`npm run build:voice-gateway`) | backend `hushh_mcp/services/voice_action_manifest.py`, frontend `lib/voice/kai-action-gateway.ts` |
| `kai/voice-action-manifest.v1.json` | Derived per-action manifest view of the gateway | same as gateway (derived) | same generator, same run | `consent-protocol/mcp_modules/tools/kai_tools.py`, docs tooling |
| `kai/one-route-orchestration-index.v1.json` | Route -> screen/playbook/action/delegation policy index | route layouts + gateway | `hushh-webapp/scripts/voice/generate-route-orchestration-index.mjs` (`npm run build:route-orchestration-index`) | backend `hushh_mcp/services/route_orchestration_index.py` (live relay route policy), frontend route tests |

## Duplication rule

`hushh-webapp/contracts/kai/*` mirrors `contracts/kai/*` byte-for-byte because
Next.js cannot import JSON from outside its project root. The generators write
BOTH copies in one run; never edit either copy directly. Verify sync with:

```bash
cd hushh-webapp && npm run verify:voice-gateway && npm run verify:route-orchestration-index
```

## Naming note

The `kai/` directory name is a preserved Kai-era compatibility identifier (see
`docs/reference/operations/brand-and-compatibility-contract.md`). The runtime
these contracts drive is One Voice; renaming the directory is a coordinated
migration across the generators, backend loaders, frontend imports, and
`.codex` governance scripts, tracked separately from routine contract changes.
