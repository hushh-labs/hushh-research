# AGENTS.md alignment audit

**Source review: 2026-10-24.** This on-demand audit distinguishes enforceable
repository contracts from engineering judgment. It does not certify deployment,
owner journeys or a coding host's actual tool registration.

```bash
python3 scripts/ops/audit_agents_md_alignment.py
python3 scripts/ops/audit_agents_md_alignment.py --json
python3 scripts/ops/audit_agents_md_alignment.py --strict
```

`--strict` also fails on recorded review debt and unresolved audit risks. Routine
CI reuses the canonical-source checks through skill lint; it does not run this
whole inventory again. See the [operations index](../operations/README.md) for
operating owners and the [development-system map](../../../.agents/README.md)
for framework navigation.

## Visual Context

Canonical visual owner: [operations index](../operations/README.md).

## One development framework

Root `AGENTS.md` loads `.agents/instructions.md`. Skills, workflows, evaluation
fixtures, configuration declarations and authored engineering lanes live under
`.agents/`. Vendor discovery directories, duplicate root policies, startup hooks
and generated host fleets are retired. The validators reject their reintroduction,
including empty vendor directories and broken discovery links.

This is a portable instruction and routing contract. A coding host must read the
entrypoint and use its supported delegation/tool controls; these files do not
silently install MCP connections or custom agents. Private local overrides remain
ignored, and preserving them does not automatically activate them in every host.

## Checks and their limits

| Boundary | Mechanical evidence | Limit |
| --- | --- | --- |
| Canonical framework | Orchestration validator and skill lint reject duplicate vendor roots and retired projections | Reading a contract does not prove an agent followed it |
| Skills | Frontmatter, governed manifests, routing and explicit portable-practice classifications | Classification does not approve pending imported behavior |
| Subagents | One authored TOML fleet, read-only authority, inheritance, bounded thread/depth settings | Host availability and actual child cleanup require runtime evidence |
| Imports | Pinned source hashes, license/provenance and imported-agent inventory | Pending review remains debt; imported writers are not activated |
| Architecture | The reviewed fitness baseline rejects new or worsened debt | Existing debt and product architecture judgment remain separate |
| Documentation | CI reaches `docs-parity-check.sh` through Governance → `bin/hushh docs verify` | Structural links and diagrams do not prove product readiness |
| Commit attribution | DCO verifies human signoff | The AI co-author prohibition remains an author/reviewer obligation |
| Release authority | Governed actor, exact-source receipts and deployment gates | A green aggregate cannot replace installed-owner acceptance |

## Reading the audit

C1–C3 inspect the canonical framework, skill definitions and single authored fleet.
C4 reports attribution policy honestly; it does not claim that DCO identifies every
co-author. C5 finds direct literal CI stage calls and requires indirect-caller review
before declaring a check disconnected. C6 follows the current documentation call
chain. C7–C8 inspect classified imports and report pending review separately from
structural drift.

Do not reuse the superseded August findings that documentation checks were absent
from CI or that a vendor-specific setting enforced attribution. The current checks
read the tree and report revision and dirty-state provenance. Re-run them after
framework or CI changes instead of treating a dated count as permanent truth.

Current pending import review remains recorded in the existing
[platform source inventory](../../../.agents/skills/agent-orchestration-governance/references/platform-source-inventory.json).
Do not dismiss it or promote imported instructions merely to make the audit green.

## Sources

- [Operating contract](../../../.agents/instructions.md)
- [Audit tool](../../../scripts/ops/audit_agents_md_alignment.py)
- [Orchestration governance](../../../.agents/skills/agent-orchestration-governance/SKILL.md)
- [Verification practice](../../../.agents/skills/verify-before-claim/SKILL.md)
