# Runtime Topology Maintenance

Classification: `canonical`.

## Visual Map

```mermaid
flowchart LR
  route[Route + semantic contract] --> index[Runtime topology index]
  action[Action + cache + native contracts] --> index
  agent[Agent manifests] --> index
  db[Database-family contract] --> index
  index --> profiles[Read-only maintenance profiles]
```

## Purpose

The runtime topology index makes the project's structural context auditable
without creating another source of execution authority. It joins the existing
route, cache, native, voice/action, product-agent, and database-family
contracts into one generated, metadata-only projection.

It records structure only: routes, semantic tab variants, owning modules,
action identifiers, declared agent hierarchy, table-family ownership, and
compatibility lifecycle. It never contains user information, credentials,
decrypted PKM, request payloads, vault material, or executable action policy.

## Sources of truth

| Concern | Authored source | Generated projection |
| --- | --- | --- |
| Physical routes and playbooks | `hushh-webapp/lib/navigation/app-route-layout.contract.json` | surface map, route-orchestration index |
| Semantic query-tab routes and aliases | `config/runtime-topology-maintenance.json` | runtime topology index |
| API/native/cache/action joins | frontend surface map, cache manifest, action gateway | runtime topology index |
| Product agents | `consent-protocol/hushh_mcp/agents/*/agent.yaml` plus declared One/A2A/dispatch wiring | product-agent registry and runtime topology index |
| Database families | `runtime-db-data-plane-contract.json` | runtime topology index |
| Compatibility and retirement decisions | `config/runtime-topology-maintenance.json` | runtime topology index |

Generated output: `contracts/architecture/runtime-topology-index.v1.json`.

Run:

```bash
python3 scripts/ops/generate_runtime_topology_index.py --check
python3 scripts/ops/generate_runtime_topology_index.py --profile finance
```

## Maintenance profiles

Profiles are deterministic review bundles, not product agents or LLM routing.
They select existing read-only evidence lanes based on the affected product
persona and structural surface:

- `one_core`: One and onboarding
- `finance`: Kai, Investor, and RIA
- `privacy_connections`: Nav, Location, and Connections
- `information_identity`: KYC, Email, Connected Systems, and Personal
  Information

The existing curated `agents` fleet remains the implementation. Adding
a generic maintenance agent would exceed the governed fleet cap and duplicate
the governor, frontend, backend, data-model, documentation, security, and
voice evidence lanes.

## Compatibility and removal discipline

An alias is not automatically stale. It remains a supported compatibility
surface until its record names a canonical successor, owner, reason, and
retirement policy. The index fails if a route page redirects while its route
contract claims it is a standard active page.

Destructive database cleanup is never an autonomous maintenance action. A
pending table retirement must stay visible in the index until an owner has
verified live row count, retention requirements, backup/recovery posture, and
a forward-only migration plan. Do not rewrite an historical migration to make
the index green.

## Product-agent boundary

One remains the only private-agent routing head. The topology index does not
change dispatch, A2A, tool admission, consent, or action authority. Runtime
agent creation follows [One Agent Hierarchy](../one/one-agent-hierarchy.md) and
the `product-agent-development` workflow; engineering maintenance follows
`runtime-topology-maintenance`.

## Recurring audit cadence

Run the existing `runtime-topology-maintenance` workflow manually when adopting
a new model or agent host. Its playbook composes shared-rule alignment, database,
environment, native and wiki evidence. This cadence does not install a scheduler
or grant deployment, publishing, database mutation or account-reset authority.

`python3 scripts/ops/audit_agents_md_alignment.py --json` exposes drift candidates;
`--strict` returns nonzero for findings and `--self-test` exercises the portable
bridge checks. Existing skill lint verifies canonical bridge metadata and targets
on both supported hosts. Platform-specific procedures and imported bundles still
need explicit classification before migration; an inventory is not proof they
are unused.

Persist a sanitized revision-bound report and compare it with the prior run.
Preserve failed and unverified results, then correct one independently reversible
boundary at a time. New model evaluations use the same contract fixtures and
negative controls as the prior baseline.

### Platform-source ratchet

`skill_lint.py` reuses the alignment audit's bridge and classification checks.
Canonical twins are discovered from `skills/`; governed owners from `skill.json`.
Remaining host aliases, adapters and imported resources are explicitly inventoried in
`.codex/skills/agent-orchestration-governance/references/platform-source-inventory.json`.
Unclassified additions (including short files), changed classified behavior, broken
canonical pointers and stale inventory entries fail lint. Updating a digest requires
reviewing the actual behavior; a pending import or migration classification is recorded
debt, not proof that the source meets the canonical contract. Impeccable's pinned
upstream tree, outer license/notices and vendored screenshot license were verified
on 2026-09-05; exact receipts and retained license paths live in the inventory above.
The importer did not record the original revision of its derived platform references.
Optional parser dependencies and bypassing host launchers still constrain execution
and relocation. Keep the bundle intact and its nested writers outside the canonical
evidence fleet; confirmed provenance is not approval to execute imported wrappers.

Existing pod receipt checks prove only the declared date window and a tracked reproduction
path. They do not establish that the current revision passed a live drill. A release audit
must re-earn runtime evidence against its exact candidate and record image and environment;
source tests, dated receipts and simulator results must remain distinguishable.

### Fleet inventory evidence

`pod_fleet.py --assert-empty` and `pod_reconcile.py` use the existing Cloud Run
client's complete paginated inventory. Redirects, malformed records, unreachable
locations, repeated continuation tokens and later-page failures are unavailable
evidence; they cannot establish an empty fleet. The assertion returns 0 only for
a complete empty observation, 1 for observed pods, and 77 when unavailable.

The report-only reconciler reads host claims in one unrestricted registry SELECT,
separate from the bounded liveness sweep. It joins recorded service identifiers
within the requested project and region. Migrating rows retain their host claims;
inactive rows with a live host are reported separately from unclaimed services.
Missing coordinates and conflicting claims produce an incomplete report (exit 2)
and suppress orphan conclusions. The legacy unscoped pure classifier remains
available for offline callers and now also recognizes migrating rows.

Cloud inventory and the registry snapshot are separate observations. Their
mismatches are review candidates, never authority to delete, adopt or retry a
resource. Neither an empty fleet nor a successful report proves provider-memory,
object-version, key or backup erasure.

### Live lifecycle producer admission

`pod_lifecycle_drill.py --live` currently returns incomplete before acquiring
cloud resources or consent authority. Its retained `GcpFleet` adapter is a
migration surface, not an approved disposable-resource runner: existing-owner
upsert, service adoption on conflict, name-only deletion and pre-cleanup reporting
must be replaced through the existing registry, Cloud Run client and lifecycle
services. Re-enabling requires exclusive attempt/incarnation ownership and
verified cleanup, including durable external erasure. The existing dry-run and
its schedule continue to test the oracle only; no new schedule is added.
